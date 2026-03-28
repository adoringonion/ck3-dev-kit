import * as path from "path";
import { pathToFileURL } from "url";
import { Diagnostic, DiagnosticSeverity, Hover, InlayHint, SemanticTokens } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createDocumentIndexRecord, WorkspaceIndex } from "../core/indexer";
import { collectParsedReferences, validateParsedReferencesAgainstIndex } from "../core/references";
import { AssignmentNode, ParsedDocument, Range as ParsedRange, ReferenceRecord, SymbolRecord, ValueNode } from "../core/types";
import { QueryEngine } from "./queryEngine";
import { RequestContext } from "./requestContext";

export type SourceKind = "mod" | "reference";

export interface ServerConfig {
  modRoots: string[];
  referenceRoots: string[];
  maxFiles: number;
  errorLogPath?: string;
}

export interface LiveDocumentRecord {
  version: number;
  parsed: ParsedDocument;
  symbols: SymbolRecord[];
  references: ReferenceRecord[];
  symbolPositions: Map<string, SymbolRecord[]>;
  referencePositions: Map<string, ReferenceRecord[]>;
  referencedNames: string[];
  diagnosticTags: string[];
  source: SourceKind;
}

export interface RenameCandidate {
  kind: string;
  source: SourceKind;
}

interface DiagnosticCacheEntry {
  version: number;
  indexRevision: number;
  diagnostics: Diagnostic[];
}

interface VersionedCacheEntry<T> {
  version: number;
  indexRevision: number;
  value: T;
}

interface DerivedSymbolState {
  revision: number;
  byName: Map<string, SymbolRecord[]>;
  all: SymbolRecord[];
  nonLocalization: SymbolRecord[];
  allByFirstChar: Map<string, SymbolRecord[]>;
  nonLocalizationByFirstChar: Map<string, SymbolRecord[]>;
  preferredAll: SymbolRecord[];
  preferredNonLocalization: SymbolRecord[];
  preferredByFirstChar: Map<string, SymbolRecord[]>;
  preferredNonLocalizationByFirstChar: Map<string, SymbolRecord[]>;
}

interface DerivedReferenceState {
  revision: number;
  byName: Map<string, ReferenceRecord[]>;
}

export class ServerState {
  private static readonly INDEX_SYMBOL_TAG = "index:symbols";
  private static readonly INDEX_REFERENCE_TAG = "index:references";
  private static readonly LIVE_SYMBOL_TAG = "live:symbols";
  private static readonly LIVE_REFERENCE_TAG = "live:references";
  private static readonly SNAPSHOT_TAG = "snapshot";
  private static readonly DIAGNOSTICS_TAG = "diagnostics";

  private config: ServerConfig = {
    modRoots: [],
    referenceRoots: [],
    maxFiles: 20000,
  };

  private index: WorkspaceIndex = {
    symbols: new Map(),
    references: new Map(),
    documents: new Map(),
    files: [],
  };
  private indexedSymbolsByPath = new Map<string, SymbolRecord[]>();
  private indexedReferencesByPath = new Map<string, ReferenceRecord[]>();
  private indexedSymbolPositionsByPath = new Map<string, Map<string, SymbolRecord[]>>();
  private indexedReferencePositionsByPath = new Map<string, Map<string, ReferenceRecord[]>>();
  private immutableIndexDocuments = new Map<string, ParsedDocument>();

  private liveDocuments = new Map<string, LiveDocumentRecord>();
  private staleDocuments = new Map<string, LiveDocumentRecord>();
  private diagnosticCache = new Map<string, DiagnosticCacheEntry>();
  private hoverCache = new Map<string, Hover | null>();
  private inlayHintCache = new Map<string, VersionedCacheEntry<InlayHint[]>>();
  private semanticTokenCache = new Map<string, VersionedCacheEntry<SemanticTokens>>();
  private analysisTimers = new Map<string, NodeJS.Timeout>();
  private diagnosticTimers = new Map<string, NodeJS.Timeout>();
  private workspaceDiagnosticRun = 0;
  private indexRevision = 0;
  private stateRevision = 0;
  private indexReady = false;
  private lastIndexError: string | null = null;
  private derivedSymbols: DerivedSymbolState | null = null;
  private derivedReferences: DerivedReferenceState | null = null;
  private immutableSnapshot: ServerSnapshot | null = null;
  private immutableSnapshotRevision = -1;
  private readonly queryEngine = new QueryEngine();

  setConfig(config: ServerConfig): void {
    this.config = config;
  }

  getConfig(): ServerConfig {
    return this.config;
  }

  queryStats(): ReturnType<QueryEngine["stats"]> {
    return this.queryEngine.stats();
  }

  setIndex(index: WorkspaceIndex): void {
    this.index = index;
    this.indexedSymbolsByPath = groupSymbolsByPath(index.symbols);
    this.indexedReferencesByPath = groupReferencesByPath(index.references);
    this.indexedSymbolPositionsByPath = groupSymbolsByPosition(this.indexedSymbolsByPath);
    this.indexedReferencePositionsByPath = groupReferencesByPosition(this.indexedReferencesByPath);
    this.immutableIndexDocuments = cloneParsedDocumentMap(index.documents);
    this.indexRevision += 1;
    this.invalidateIndexQueries();
    this.bumpStateRevision();
    this.indexReady = true;
    this.lastIndexError = null;
    this.clearTransientState();
  }

  markIndexFailed(message: string): void {
    this.indexReady = false;
    this.lastIndexError = message;
  }

  markIndexRebuilding(): void {
    this.indexReady = false;
    this.lastIndexError = null;
  }

  getIndex(): WorkspaceIndex {
    return this.index;
  }

  getIndexRevision(): number {
    return this.indexRevision;
  }

  isIndexReady(): boolean {
    return this.indexReady;
  }

  getLastIndexError(): string | null {
    return this.lastIndexError;
  }

  snapshot(): ServerSnapshot {
    if (this.immutableSnapshot && this.immutableSnapshotRevision === this.stateRevision) {
      return this.immutableSnapshot;
    }
    const liveDocuments = cloneLiveDocuments(this.liveDocuments);
    const parsedByUri = new Map<string, ParsedDocument>();
    const parsedByPath = new Map<string, ParsedDocument>(this.immutableIndexDocuments);

    for (const [uri, record] of liveDocuments.entries()) {
      const parsed = record.parsed;
      parsedByUri.set(uri, parsed);
      parsedByPath.set(uriToFsPath(uri), parsed);
    }

    this.immutableSnapshot = new ServerSnapshot({
      indexReady: this.indexReady,
      indexRevision: this.indexRevision,
      lastIndexError: this.lastIndexError,
      symbolState: cloneDerivedSymbolState(this.getDerivedSymbols()),
      referenceState: cloneDerivedReferenceState(this.getDerivedReferences()),
      indexedSymbolPositionsByPath: cloneNestedSymbolArrayMap(this.indexedSymbolPositionsByPath),
      indexedReferencePositionsByPath: cloneNestedReferenceArrayMap(this.indexedReferencePositionsByPath),
      liveDocuments,
      parsedByUri,
      parsedByPath,
      hoverCache: new Map(this.hoverCache),
      inlayHintCache: new Map(this.inlayHintCache),
      semanticTokenCache: new Map(this.semanticTokenCache),
    });
    this.immutableSnapshotRevision = this.stateRevision;
    return this.immutableSnapshot;
  }

  setLiveDocument(document: TextDocument, source: SourceKind): LiveDocumentRecord {
    const filePath = uriToFsPath(document.uri);
    const previous = this.liveDocuments.get(document.uri);
    const indexed = createDocumentIndexRecord(filePath, document.getText(), source);
    const record = {
      version: document.version,
      ...indexed,
      symbolPositions: buildSymbolPositionMap(indexed.symbols),
      referencePositions: buildReferencePositionMap(indexed.references),
      ...buildDocumentDependencies(document.uri, indexed.symbols, indexed.references),
      source,
    };
    this.liveDocuments.set(document.uri, record);
    this.invalidateLiveDocumentQueries(document.uri, previous, record);
    this.bumpStateRevision();
    this.clearDocumentFeatureCaches(document.uri);
    return record;
  }

  hydrateLiveDocumentFromIndex(document: TextDocument, source: SourceKind): LiveDocumentRecord | null {
    const filePath = uriToFsPath(document.uri);
    const parsed = this.index.documents.get(filePath);
    if (!parsed || parsed.text !== document.getText()) {
      return null;
    }
    const record: LiveDocumentRecord = {
      version: document.version,
      parsed,
      symbols: this.indexedSymbolsByPath.get(filePath) ?? [],
      references: this.indexedReferencesByPath.get(filePath) ?? [],
      symbolPositions: this.indexedSymbolPositionsByPath.get(filePath) ?? new Map(),
      referencePositions: this.indexedReferencePositionsByPath.get(filePath) ?? new Map(),
      ...buildDocumentDependencies(
        document.uri,
        this.indexedSymbolsByPath.get(filePath) ?? [],
        this.indexedReferencesByPath.get(filePath) ?? [],
      ),
      source,
    };
    const previous = this.liveDocuments.get(document.uri);
    this.liveDocuments.set(document.uri, record);
    this.invalidateLiveDocumentQueries(document.uri, previous, record);
    this.bumpStateRevision();
    this.clearDocumentFeatureCaches(document.uri);
    return record;
  }

  deleteLiveDocument(uri: string): void {
    const previous = this.liveDocuments.get(uri);
    if (this.liveDocuments.delete(uri)) {
      this.invalidateLiveDocumentQueries(uri, previous, undefined);
      this.bumpStateRevision();
    }
    this.staleDocuments.delete(uri);
    this.deleteDiagnosticCache(uri);
    this.clearDocumentFeatureCaches(uri);
  }

  getLiveDocument(uri: string): LiveDocumentRecord | undefined {
    return this.liveDocuments.get(uri);
  }

  getStaleDocument(uri: string): LiveDocumentRecord | undefined {
    return this.staleDocuments.get(uri);
  }

  getAnalysisBaseParsed(uri: string, filePath?: string): ParsedDocument | undefined {
    return this.staleDocuments.get(uri)?.parsed
      ?? this.liveDocuments.get(uri)?.parsed
      ?? (filePath ? this.index.documents.get(filePath) : undefined);
  }

  hasCurrentAnalysis(document: TextDocument): boolean {
    return this.liveDocuments.get(document.uri)?.version === document.version;
  }

  liveDocumentEntries(): IterableIterator<[string, LiveDocumentRecord]> {
    return this.liveDocuments.entries();
  }

  liveDocumentUris(): string[] {
    return [...this.liveDocuments.keys()];
  }

  getParsedDocumentForUri(uri: string): ParsedDocument | undefined {
    return this.liveDocuments.get(uri)?.parsed;
  }

  getParsedDocumentForPath(filePath: string): ParsedDocument | undefined {
    return this.liveDocuments.get(pathToFileURL(filePath).toString())?.parsed ?? this.index.documents.get(filePath);
  }

  getDiagnosticCache(uri: string): DiagnosticCacheEntry | undefined {
    return this.diagnosticCache.get(uri);
  }

  setDiagnosticCache(uri: string, version: number, diagnostics: Diagnostic[]): void {
    this.diagnosticCache.set(uri, {
      version,
      indexRevision: this.indexRevision,
      diagnostics,
    });
  }

  deleteDiagnosticCache(uri: string): void {
    this.diagnosticCache.delete(uri);
  }

  hoverCacheKey(document: TextDocument, range: { start: { line: number; character: number }; end: { line: number; character: number } }): string {
    return [
      document.uri,
      document.version,
      this.indexRevision,
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
    ].join(":");
  }

  getHoverCache(key: string): Hover | null | undefined {
    return this.hoverCache.get(key);
  }

  setHoverCache(key: string, hover: Hover | null): void {
    this.hoverCache.set(key, hover);
  }

  clearHoverCacheForUri(uri: string): void {
    for (const key of this.hoverCache.keys()) {
      if (key.startsWith(`${uri}:`)) {
        this.hoverCache.delete(key);
      }
    }
  }

  getInlayHintCache(uri: string, version: number): InlayHint[] | undefined {
    const cached = this.inlayHintCache.get(uri);
    if (cached && cached.version === version && cached.indexRevision === this.indexRevision) {
      return cached.value;
    }
    return undefined;
  }

  setInlayHintCache(uri: string, version: number, hints: InlayHint[]): void {
    this.inlayHintCache.set(uri, {
      version,
      indexRevision: this.indexRevision,
      value: hints,
    });
  }

  getSemanticTokenCache(uri: string, version: number): SemanticTokens | undefined {
    const cached = this.semanticTokenCache.get(uri);
    if (cached && cached.version === version && cached.indexRevision === this.indexRevision) {
      return cached.value;
    }
    return undefined;
  }

  setSemanticTokenCache(uri: string, version: number, tokens: SemanticTokens): void {
    this.semanticTokenCache.set(uri, {
      version,
      indexRevision: this.indexRevision,
      value: tokens,
    });
  }

  clearTransientState(): void {
    this.diagnosticCache.clear();
    this.hoverCache.clear();
    this.inlayHintCache.clear();
    this.semanticTokenCache.clear();
    this.cancelAllDocumentAnalysis();
    this.cancelAllDocumentDiagnostics();
    this.cancelWorkspaceDiagnostics();
  }

  clearDocumentFeatureCaches(uri: string): void {
    this.clearHoverCacheForUri(uri);
    this.inlayHintCache.delete(uri);
    this.semanticTokenCache.delete(uri);
  }

  symbolsByName(name: string, context?: RequestContext): SymbolRecord[] {
    return this.queryEngine.evaluate(
      `symbolsByName:${name}`,
      () => {
        context?.checkpoint();
        return this.getDerivedSymbols(context).byName.get(name) ?? [];
      },
      [`symbol:${name}`],
    );
  }

  referencesByName(name: string, context?: RequestContext): ReferenceRecord[] {
    return this.queryEngine.evaluate(
      `referencesByName:${name}`,
      () => {
        context?.checkpoint();
        return this.getDerivedReferences(context).byName.get(name) ?? [];
      },
      [`reference:${name}`],
    );
  }

  allSymbols(query?: string, context?: RequestContext): SymbolRecord[] {
    const merged = this.queryEngine.evaluate("allSymbols:*", () => {
      context?.checkpoint();
      return this.getDerivedSymbols(context).all;
    }, ["allSymbols"]);
    if (!query) {
      return merged;
    }
    const lowered = query.toLowerCase();
    return merged.filter((symbol) => symbol.name.toLowerCase().includes(lowered));
  }

  overlaySymbols(documentUri: string, symbols: SymbolRecord[], names: Set<string>, context?: RequestContext): Map<string, SymbolRecord[]> {
    const liveUris = new Set(this.liveDocuments.keys());
    liveUris.add(documentUri);
    const merged = new Map<string, SymbolRecord[]>();

    for (const name of names) {
      context?.checkpoint();
      const entries = this.index.symbols.get(name) ?? [];
      const filtered = entries.filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
      if (filtered.length > 0) {
        merged.set(name, filtered);
      }
    }

    for (const [uri, record] of this.liveDocuments.entries()) {
      context?.checkpoint();
      if (uri === documentUri) {
        continue;
      }
      for (const entry of record.symbols) {
        if (!names.has(entry.name)) {
          continue;
        }
        const existing = merged.get(entry.name) ?? [];
        existing.push(entry);
        merged.set(entry.name, existing);
      }
    }

    for (const entry of symbols) {
      context?.checkpoint();
      if (!names.has(entry.name)) {
        continue;
      }
      const existing = merged.get(entry.name) ?? [];
      existing.push(entry);
      merged.set(entry.name, existing);
    }

    return merged;
  }

  resolveSource(filePath: string): SourceKind {
    return this.config.referenceRoots.some((root) => filePath.startsWith(root)) ? "reference" : "mod";
  }

  openDocument(document: TextDocument): LiveDocumentRecord | null {
    const filePath = uriToFsPath(document.uri);
    if (!matchesCk3Path(filePath)) {
      this.deleteLiveDocument(document.uri);
      return null;
    }
    const source = this.resolveSource(filePath);
    const current = this.liveDocuments.get(document.uri);
    if (current?.version === document.version) {
      return current;
    }
    const hydrated = this.hydrateLiveDocumentFromIndex(document, source);
    if (hydrated) {
      return hydrated;
    }
    return null;
  }

  markDocumentChanged(document: TextDocument): void {
    const filePath = uriToFsPath(document.uri);
    if (!matchesCk3Path(filePath)) {
      this.deleteLiveDocument(document.uri);
      return;
    }
    const stale = this.liveDocuments.get(document.uri);
    if (this.liveDocuments.delete(document.uri)) {
      if (stale) {
        this.staleDocuments.set(document.uri, stale);
      }
      this.invalidateLiveDocumentQueries(document.uri, stale, undefined);
      this.bumpStateRevision();
    }
    this.deleteDiagnosticCache(document.uri);
    this.clearDocumentFeatureCaches(document.uri);
  }

  analyzeDocument(document: TextDocument): LiveDocumentRecord | null {
    const filePath = uriToFsPath(document.uri);
    if (!matchesCk3Path(filePath)) {
      this.deleteLiveDocument(document.uri);
      return null;
    }
    const source = this.resolveSource(filePath);
    return this.setLiveDocument(document, source);
  }

  applyAnalyzedDocument(
    uri: string,
    version: number,
    source: SourceKind,
    parsed: ParsedDocument,
    symbols: SymbolRecord[],
    references: ReferenceRecord[]
  ): LiveDocumentRecord {
    const previous = this.liveDocuments.get(uri);
    const record: LiveDocumentRecord = {
      version,
      parsed,
      symbols,
      references,
      symbolPositions: buildSymbolPositionMap(symbols),
      referencePositions: buildReferencePositionMap(references),
      ...buildDocumentDependencies(uri, symbols, references),
      source,
    };
    this.liveDocuments.set(uri, record);
    this.staleDocuments.delete(uri);
    this.invalidateLiveDocumentQueries(uri, previous, record);
    this.bumpStateRevision();
    this.deleteDiagnosticCache(uri);
    this.clearDocumentFeatureCaches(uri);
    return record;
  }

  collectDocumentDiagnostics(document: TextDocument, context?: RequestContext): Diagnostic[] {
    const filePath = uriToFsPath(document.uri);
    const live = this.getLiveDocument(document.uri);
    const tags = live
      ? live.diagnosticTags
      : [ServerState.DIAGNOSTICS_TAG, `diagnostics:${document.uri}`];
    return this.queryEngine.evaluate(`documentDiagnostics:${document.uri}`, () => {
      context?.checkpoint();
      const cached = this.getDiagnosticCache(document.uri);
      if (cached && cached.version === document.version && cached.indexRevision === this.indexRevision) {
        return cached.diagnostics;
      }

      if (!live || live.version !== document.version) {
        return [];
      }
      const diagnostics = this.collectValidationDiagnostics(
        this.snapshot(),
        document.uri,
        filePath,
        live.parsed,
        live.symbols,
        live.references,
        live.referencedNames,
        context,
      );
      this.setDiagnosticCache(document.uri, document.version, diagnostics);
      return diagnostics;
    }, tags);
  }

  collectIndexedDiagnostics(filePath: string, parsed: ParsedDocument, context?: RequestContext): Diagnostic[] {
    const documentUri = pathToFileURL(filePath).toString();
    const references = this.referenceRecordsForPath(filePath, parsed);
    const symbols = this.symbolRecordsForPath(filePath, parsed);
    return this.queryEngine.evaluate(`indexedDiagnostics:${filePath}`, () => this.collectValidationDiagnostics(
      this.snapshot(),
      documentUri,
      filePath,
      parsed,
      symbols,
      references,
      collectReferencedNames(symbols, references),
      context,
    ), diagnosticDependencyTags(documentUri, symbols, references));
  }

  completionSymbols(kinds: string[], query = "", limit = 100, context?: RequestContext): SymbolRecord[] {
    const normalizedKinds = [...kinds].sort().join(",");
    const cacheKey = `completion:${normalizedKinds}:${query.toLowerCase()}:${limit}`;
    return this.queryEngine.evaluate(cacheKey, () => {
      context?.checkpoint();
      const lowered = query.toLowerCase();
      const matches: SymbolRecord[] = [];
      for (const records of this.getDerivedSymbols(context).byName.values()) {
        context?.checkpoint();
        const relevant = records
          .filter((symbol) => symbolMatchesCompletionKinds(symbol.kind, kinds))
          .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod"));
        if (relevant.length === 0) {
          continue;
        }
        const candidate = relevant[0];
        if (lowered && !candidate.name.toLowerCase().includes(lowered)) {
          continue;
        }
        matches.push(candidate);
      }

      matches.sort((left, right) => {
        const leftName = left.name.toLowerCase();
        const rightName = right.name.toLowerCase();
        const leftStarts = lowered ? leftName.startsWith(lowered) : false;
        const rightStarts = lowered ? rightName.startsWith(lowered) : false;
        if (leftStarts !== rightStarts) {
          return Number(rightStarts) - Number(leftStarts);
        }
        if (left.source !== right.source) {
          return Number(right.source === "mod") - Number(left.source === "mod");
        }
        return left.name.localeCompare(right.name);
      });

      const result = matches.slice(0, limit);
      return result;
    }, ["completion"]);
  }

  definitionSymbols(name: string, context?: RequestContext): SymbolRecord[] {
    return this.queryEngine.evaluate(
      `definitionSymbols:${name}`,
      () => this.symbolsByName(name, context)
        .filter((symbol) => symbol.kind !== "localization-reference")
        .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod")),
      [`definition:${name}`],
    );
  }

  preferredDefinition(name: string, context?: RequestContext): SymbolRecord | undefined {
    return this.definitionSymbols(name, context)[0];
  }

  workspaceSymbols(query?: string, context?: RequestContext): SymbolRecord[] {
    const cacheKey = query?.toLowerCase() ?? "";
    return this.queryEngine.evaluate(`workspaceSymbols:${cacheKey}`, () => {
      context?.checkpoint();
      return this.allSymbols(query, context).filter((symbol) => symbol.kind !== "localization-reference");
    }, ["workspaceSymbols"]);
  }

  preferredLocalizationFile(): string | null {
    for (const root of this.config.modRoots) {
      const folder = path.join(root, "localization");
      if (fsExists(folder)) {
        return path.join(folder, "english", "zz_generated_l_english.yml");
      }
    }
    return null;
  }

  preferredScriptDefinitionFile(kind: "scripted_effect" | "scripted_trigger" | "script_value"): string | null {
    const relativeFolder =
      kind === "scripted_effect"
        ? path.join("common", "scripted_effects")
        : kind === "scripted_trigger"
          ? path.join("common", "scripted_triggers")
          : path.join("common", "script_values");
    const fallbackName =
      kind === "scripted_effect"
        ? "zz_generated_effects.txt"
        : kind === "scripted_trigger"
          ? "zz_generated_triggers.txt"
          : "zz_generated_values.txt";

    for (const root of this.config.modRoots) {
      const folder = path.join(root, relativeFolder);
      const parent = path.dirname(folder);
      if (!fsExists(parent) && !fsExists(folder)) {
        continue;
      }
      return path.join(folder, fallbackName);
    }
    return null;
  }

  preferredEventFile(eventId: string): string | null {
    const namespace = eventId.includes(".") ? eventId.split(".")[0] : "generated";
    for (const root of this.config.modRoots) {
      const folder = path.join(root, "events");
      const parent = path.dirname(folder);
      if (!fsExists(parent) && !fsExists(folder)) {
        continue;
      }
      return path.join(folder, `${namespace}_events.txt`);
    }
    return null;
  }

  renameCandidate(documentUri: string, position: { line: number; character: number }, name: string, context?: RequestContext): RenameCandidate | null {
    const cacheKey = `renameCandidate:${documentUri}:${position.line}:${position.character}:${name}`;
    return this.queryEngine.evaluate(cacheKey, () => {
      context?.checkpoint();
      const filePath = uriToFsPath(documentUri);
      const positionKey = toPositionKey(position.line, position.character);
      const live = this.getLiveDocument(documentUri);
      const symbols = (live?.symbolPositions.get(positionKey) ?? []).filter((symbol) => symbol.name === name);
      if (symbols.length > 0) {
        return { kind: symbols[0].kind, source: symbols[0].source };
      }

      const baseSymbols = (this.indexedSymbolPositionsByPath.get(filePath)?.get(positionKey) ?? [])
        .filter((symbol) => symbol.name === name);
      if (baseSymbols.length > 0) {
        return { kind: baseSymbols[0].kind, source: baseSymbols[0].source };
      }

      const references = (live?.referencePositions.get(positionKey) ?? []).filter((reference) => reference.name === name);
      if (references.length > 0) {
        return { kind: referenceKind(references[0]), source: references[0].source };
      }

      const baseReferences = (this.indexedReferencePositionsByPath.get(filePath)?.get(positionKey) ?? [])
        .filter((reference) => reference.name === name);
      if (baseReferences.length > 0) {
        return { kind: referenceKind(baseReferences[0]), source: baseReferences[0].source };
      }

      return null;
    }, [`rename:${documentUri}`, `symbol:${name}`, `reference:${name}`]);
  }

  symbolSnippet(symbol: SymbolRecord): string | undefined {
    return this.queryEngine.evaluate(`symbolSnippet:${symbol.path}:${symbol.range.start.line}:${symbol.range.end.line}`, () => {
      const lines = this.pathLines(symbol.path);
      if (!lines) {
        return undefined;
      }
      const startLine = Math.max(symbol.range.start.line - 1, 0);
      const endLine = Math.min(symbol.range.end.line + 1, lines.length - 1);
      return lines.slice(startLine, endLine + 1).join("\n").trim();
    }, [`path:${symbol.path}`]);
  }

  localizationText(symbol: SymbolRecord): string | undefined {
    if (symbol.kind !== "localization") {
      return undefined;
    }
    return this.queryEngine.evaluate(`localizationText:${symbol.path}:${symbol.name}`, () => {
      return this.localizationEntries(symbol.path)?.get(symbol.name);
    }, [`path:${symbol.path}`, `symbol:${symbol.name}`]);
  }

  localizationLanguage(symbol: SymbolRecord): string | null | undefined {
    if (symbol.kind !== "localization") {
      return undefined;
    }
    return this.queryEngine.evaluate(`localizationLanguage:${symbol.path}`, () => {
      const parsed = this.getParsedDocumentForPath(symbol.path);
      if (!parsed || parsed.kind !== "localization") {
        return undefined;
      }
      return parsed.language;
    }, [`path:${symbol.path}`]);
  }

  private pathLines(filePath: string): string[] | undefined {
    return this.queryEngine.evaluate(`pathLines:${filePath}`, () => {
      const text = this.getParsedDocumentForPath(filePath)?.text;
      return text ? text.split(/\r?\n/) : undefined;
    }, [`path:${filePath}`]);
  }

  private localizationEntries(filePath: string): Map<string, string> | undefined {
    return this.queryEngine.evaluate(`localizationEntries:${filePath}`, () => {
      const parsed = this.getParsedDocumentForPath(filePath);
      if (!parsed || parsed.kind !== "localization") {
        return undefined;
      }
      const entries = new Map<string, string>();
      for (const entry of parsed.entries) {
        entries.set(entry.key, entry.value);
      }
      return entries;
    }, [`path:${filePath}`]);
  }

  private symbolRecordsForPath(filePath: string, parsed: ParsedDocument): SymbolRecord[] {
    return this.indexedSymbolsByPath.get(filePath)
      ?? createDocumentIndexRecord(filePath, parsed.text, this.resolveSource(filePath)).symbols;
  }

  private referenceRecordsForPath(filePath: string, parsed: ParsedDocument): ReferenceRecord[] {
    return this.indexedReferencesByPath.get(filePath)
      ?? collectParsedReferences(parsed);
  }

  scheduleDocumentDiagnostics(uri: string, delayMs: number, publish: () => void): void {
    this.cancelDocumentDiagnostics(uri);
    const timer = setTimeout(() => {
      this.diagnosticTimers.delete(uri);
      publish();
    }, delayMs);
    this.diagnosticTimers.set(uri, timer);
  }

  cancelDocumentDiagnostics(uri: string): void {
    const timer = this.diagnosticTimers.get(uri);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.diagnosticTimers.delete(uri);
  }

  cancelAllDocumentDiagnostics(): void {
    for (const timer of this.diagnosticTimers.values()) {
      clearTimeout(timer);
    }
    this.diagnosticTimers.clear();
  }

  scheduleDocumentAnalysis(uri: string, delayMs: number, analyze: () => void): void {
    this.cancelDocumentAnalysis(uri);
    const timer = setTimeout(() => {
      this.analysisTimers.delete(uri);
      analyze();
    }, delayMs);
    this.analysisTimers.set(uri, timer);
  }

  cancelDocumentAnalysis(uri: string): void {
    const timer = this.analysisTimers.get(uri);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.analysisTimers.delete(uri);
  }

  cancelAllDocumentAnalysis(): void {
    for (const timer of this.analysisTimers.values()) {
      clearTimeout(timer);
    }
    this.analysisTimers.clear();
  }

  scheduleWorkspaceDiagnostics<TEntry>(
    entries: TEntry[],
    processEntry: (entry: TEntry) => void,
    options?: {
      initialDelayMs?: number;
      batchBudgetMs?: number;
      batchIntervalMs?: number;
      isCancelled?: () => boolean;
      onProgress?: (processed: number, total: number) => void;
    }
  ): void {
    const initialDelayMs = options?.initialDelayMs ?? 5000;
    const batchBudgetMs = options?.batchBudgetMs ?? 8;
    const batchIntervalMs = options?.batchIntervalMs ?? 100;
    const runId = ++this.workspaceDiagnosticRun;
    let cursor = 0;

    const processBatch = () => {
      if (runId !== this.workspaceDiagnosticRun || options?.isCancelled?.()) {
        return;
      }
      const started = Date.now();
      while (cursor < entries.length && Date.now() - started < batchBudgetMs) {
        if (options?.isCancelled?.()) {
          return;
        }
        processEntry(entries[cursor]);
        cursor += 1;
      }
      options?.onProgress?.(cursor, entries.length);

      if (cursor < entries.length && !options?.isCancelled?.()) {
        setTimeout(processBatch, batchIntervalMs);
      }
    };

    setTimeout(() => {
      if (options?.isCancelled?.()) {
        return;
      }
      processBatch();
    }, initialDelayMs);
  }

  cancelWorkspaceDiagnostics(): void {
    this.workspaceDiagnosticRun += 1;
  }

  private bumpStateRevision(): void {
    this.stateRevision += 1;
    this.immutableSnapshot = null;
    this.immutableSnapshotRevision = -1;
  }

  private getDerivedSymbols(context?: RequestContext): DerivedSymbolState {
    return this.queryEngine.evaluate("derivedSymbols", () => {
      if (this.derivedSymbols && this.derivedSymbols.revision === this.stateRevision) {
        return this.derivedSymbols;
      }
      context?.checkpoint();
      const liveUris = new Set(this.liveDocuments.keys());
      const byName = new Map<string, SymbolRecord[]>();
      const all: SymbolRecord[] = [];
      let processed = 0;

      for (const [name, entries] of this.index.symbols.entries()) {
        if (processed % 128 === 0) {
          context?.checkpoint();
        }
        processed += 1;
        const filtered = entries.filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
        if (filtered.length === 0) {
          continue;
        }
        byName.set(name, [...filtered]);
        all.push(...filtered);
      }

      for (const record of this.liveDocuments.values()) {
        context?.checkpoint();
        for (const entry of record.symbols) {
          const existing = byName.get(entry.name) ?? [];
          existing.push(entry);
          byName.set(entry.name, existing);
          all.push(entry);
        }
      }

      const preferredAll = buildPreferredSymbols(byName, false);
      const preferredNonLocalization = buildPreferredSymbols(byName, true);
      const nonLocalization = all.filter((symbol) => symbol.kind !== "localization-reference");
      this.derivedSymbols = {
        revision: this.stateRevision,
        byName,
        all,
        nonLocalization,
        allByFirstChar: buildPreferredByFirstChar(all),
        nonLocalizationByFirstChar: buildPreferredByFirstChar(nonLocalization),
        preferredAll,
        preferredNonLocalization,
        preferredByFirstChar: buildPreferredByFirstChar(preferredAll),
        preferredNonLocalizationByFirstChar: buildPreferredByFirstChar(preferredNonLocalization),
      };
      return this.derivedSymbols;
    }, [ServerState.INDEX_SYMBOL_TAG, ServerState.LIVE_SYMBOL_TAG]);
  }

  private getDerivedReferences(context?: RequestContext): DerivedReferenceState {
    return this.queryEngine.evaluate("derivedReferences", () => {
      if (this.derivedReferences && this.derivedReferences.revision === this.stateRevision) {
        return this.derivedReferences;
      }
      context?.checkpoint();
      const liveUris = new Set(this.liveDocuments.keys());
      const byName = new Map<string, ReferenceRecord[]>();
      let processed = 0;

      for (const [name, entries] of this.index.references.entries()) {
        if (processed % 128 === 0) {
          context?.checkpoint();
        }
        processed += 1;
        const filtered = entries.filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
        if (filtered.length > 0) {
          byName.set(name, [...filtered]);
        }
      }

      for (const record of this.liveDocuments.values()) {
        context?.checkpoint();
        for (const entry of record.references) {
          const existing = byName.get(entry.name) ?? [];
          existing.push(entry);
          byName.set(entry.name, existing);
        }
      }

      this.derivedReferences = {
        revision: this.stateRevision,
        byName,
      };
      return this.derivedReferences;
    }, [ServerState.INDEX_REFERENCE_TAG, ServerState.LIVE_REFERENCE_TAG]);
  }

  private invalidateIndexQueries(): void {
    this.derivedSymbols = null;
    this.derivedReferences = null;
    this.queryEngine.markDirtyTag(ServerState.INDEX_SYMBOL_TAG);
    this.queryEngine.markDirtyTag(ServerState.INDEX_REFERENCE_TAG);
    this.queryEngine.markDirtyTag(ServerState.SNAPSHOT_TAG);
    this.queryEngine.markDirtyTag(ServerState.DIAGNOSTICS_TAG);
  }

  private invalidateLiveDocumentQueries(
    uri: string,
    previous: LiveDocumentRecord | undefined,
    next: LiveDocumentRecord | undefined,
  ): void {
    if (this.derivedSymbols) {
      updateDerivedSymbolsForLiveChange(this.derivedSymbols, previous, next);
      this.derivedSymbols.revision = this.stateRevision + 1;
    }
    if (this.derivedReferences) {
      updateDerivedReferencesForLiveChange(this.derivedReferences, previous, next);
      this.derivedReferences.revision = this.stateRevision + 1;
    }
    const symbolNames = new Set<string>();
    const referenceNames = new Set<string>();

    for (const symbol of previous?.symbols ?? []) {
      symbolNames.add(symbol.name);
    }
    for (const symbol of next?.symbols ?? []) {
      symbolNames.add(symbol.name);
    }
    for (const reference of previous?.references ?? []) {
      referenceNames.add(reference.name);
    }
    for (const reference of next?.references ?? []) {
      referenceNames.add(reference.name);
    }

    this.queryEngine.markDirtyTag(ServerState.LIVE_SYMBOL_TAG);
    this.queryEngine.markDirtyTag(ServerState.LIVE_REFERENCE_TAG);
    this.queryEngine.markDirtyTag(ServerState.SNAPSHOT_TAG);
    this.queryEngine.markDirtyTag(ServerState.DIAGNOSTICS_TAG);
    this.queryEngine.markDirtyTag(`diagnostics:${uri}`);
    this.queryEngine.markDirtyTag(`rename:${uri}`);
    this.queryEngine.markDirtyTag(`path:${uriToFsPath(uri)}`);

    for (const tag of previous?.diagnosticTags ?? []) {
      this.queryEngine.markDirtyTag(tag);
    }
    for (const tag of next?.diagnosticTags ?? []) {
      this.queryEngine.markDirtyTag(tag);
    }

    for (const name of symbolNames) {
      this.queryEngine.markDirtyTag(`symbol:${name}`);
      this.queryEngine.markDirtyTag(`definition:${name}`);
    }

    for (const name of referenceNames) {
      this.queryEngine.markDirtyTag(`reference:${name}`);
    }
  }

  private collectValidationDiagnostics(
    snapshot: ServerSnapshot,
    documentUri: string,
    filePath: string,
    parsed: ParsedDocument,
    liveSymbols?: SymbolRecord[],
    liveReferences?: ReferenceRecord[],
    referencedNames?: string[],
    context?: RequestContext,
  ): Diagnostic[] {
    context?.checkpoint();
    const symbols = liveSymbols ?? this.symbolRecordsForPath(filePath, parsed);
    const references = liveReferences ?? this.referenceRecordsForPath(filePath, parsed);
    const overlayedSymbols = snapshot.overlaySymbols(
      documentUri,
      symbols,
      new Set(referencedNames ?? collectReferencedNames(symbols, references)),
      context,
    );
    const validation = validateParsedReferencesAgainstIndex(parsed, references, {
      ...this.index,
      symbols: overlayedSymbols,
    }, {
      checkpoint: () => context?.checkpoint(),
    });

    const diagnostics = validation.map((entry) => ({
      severity:
        entry.severity === "error"
          ? DiagnosticSeverity.Error
          : entry.severity === "warning"
            ? DiagnosticSeverity.Warning
            : DiagnosticSeverity.Information,
      message: entry.message,
      range: toLspRange(entry.range),
      source: "ck3-devkit",
    }));

    if (parsed.kind === "localization" && this.resolveSource(filePath) === "mod" && !parsed.text.startsWith("\uFEFF")) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        message: "Localization files should be saved as UTF-8 with BOM.",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        source: "ck3-devkit",
      });
    }

    return diagnostics;
  }
}

function toLspRange(range: ParsedRange): Diagnostic["range"] {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function uriToFsPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  const pathname = decodeURIComponent(new URL(uri).pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) {
    return pathname.slice(1);
  }
  return path.normalize(pathname);
}

function matchesCk3Path(filePath: string): boolean {
  return /\.(txt|gui|info|asset|yml)$/i.test(filePath);
}

function symbolMatchesCompletionKinds(symbolKind: string, completionKinds: string[]): boolean {
  return completionKinds.some((kind) => {
    if (kind === "character_modifier" || kind === "county_modifier" || kind === "province_modifier" || kind === "artifact_modifier") {
      return symbolKind === "modifier";
    }
    return symbolKind === kind;
  });
}

function referenceKind(reference: ReferenceRecord): string {
  return reference.kind;
}

function fsExists(filePath: string): boolean {
  try {
    return require("fs").existsSync(filePath);
  } catch {
    return false;
  }
}

function groupSymbolsByPath(indexedSymbols: Map<string, SymbolRecord[]>): Map<string, SymbolRecord[]> {
  const grouped = new Map<string, SymbolRecord[]>();
  for (const entries of indexedSymbols.values()) {
    for (const entry of entries) {
      const existing = grouped.get(entry.path) ?? [];
      existing.push(entry);
      grouped.set(entry.path, existing);
    }
  }
  return grouped;
}

function groupReferencesByPath(indexedReferences: Map<string, ReferenceRecord[]>): Map<string, ReferenceRecord[]> {
  const grouped = new Map<string, ReferenceRecord[]>();
  for (const entries of indexedReferences.values()) {
    for (const entry of entries) {
      const existing = grouped.get(entry.path) ?? [];
      existing.push(entry);
      grouped.set(entry.path, existing);
    }
  }
  return grouped;
}

function buildPreferredSymbols(byName: Map<string, SymbolRecord[]>, excludeLocalization: boolean): SymbolRecord[] {
  const preferred: SymbolRecord[] = [];
  for (const records of byName.values()) {
    const filtered = excludeLocalization
      ? records.filter((symbol) => symbol.kind !== "localization-reference")
      : records;
    if (filtered.length === 0) {
      continue;
    }
    const sorted = [...filtered].sort((left, right) => {
      if (left.source !== right.source) {
        return Number(right.source === "mod") - Number(left.source === "mod");
      }
      return left.name.localeCompare(right.name);
    });
    preferred.push(sorted[0]);
  }
  return preferred;
}

function buildPreferredByFirstChar(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const grouped = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    const key = symbol.name[0]?.toLowerCase() ?? "";
    const existing = grouped.get(key) ?? [];
    existing.push(symbol);
    grouped.set(key, existing);
  }
  return grouped;
}

function cloneSymbolArrayMap(source: Map<string, SymbolRecord[]>): Map<string, SymbolRecord[]> {
  const cloned = new Map<string, SymbolRecord[]>();
  for (const [key, symbols] of source.entries()) {
    cloned.set(key, [...symbols]);
  }
  return cloned;
}

function cloneReferenceArrayMap(source: Map<string, ReferenceRecord[]>): Map<string, ReferenceRecord[]> {
  const cloned = new Map<string, ReferenceRecord[]>();
  for (const [key, references] of source.entries()) {
    cloned.set(key, [...references]);
  }
  return cloned;
}

function cloneNestedSymbolArrayMap(source: Map<string, Map<string, SymbolRecord[]>>): Map<string, Map<string, SymbolRecord[]>> {
  const cloned = new Map<string, Map<string, SymbolRecord[]>>();
  for (const [filePath, entries] of source.entries()) {
    cloned.set(filePath, cloneSymbolArrayMap(entries));
  }
  return cloned;
}

function cloneNestedReferenceArrayMap(source: Map<string, Map<string, ReferenceRecord[]>>): Map<string, Map<string, ReferenceRecord[]>> {
  const cloned = new Map<string, Map<string, ReferenceRecord[]>>();
  for (const [filePath, entries] of source.entries()) {
    cloned.set(filePath, cloneReferenceArrayMap(entries));
  }
  return cloned;
}

function updateDerivedSymbolsForLiveChange(
  state: DerivedSymbolState,
  previous: LiveDocumentRecord | undefined,
  next: LiveDocumentRecord | undefined,
): void {
  for (const symbol of previous?.symbols ?? []) {
    const existing = state.byName.get(symbol.name);
    if (!existing) {
      continue;
    }
    const filtered = existing.filter((entry) => entry.path !== symbol.path || entry.range.start.offset !== symbol.range.start.offset);
    if (filtered.length === 0) {
      state.byName.delete(symbol.name);
    } else {
      state.byName.set(symbol.name, filtered);
    }
  }
  for (const symbol of next?.symbols ?? []) {
    const existing = state.byName.get(symbol.name) ?? [];
    existing.push(symbol);
    state.byName.set(symbol.name, existing);
  }
  const preferredAll = buildPreferredSymbols(state.byName, false);
  const preferredNonLocalization = buildPreferredSymbols(state.byName, true);
  state.all = flattenSymbolMap(state.byName);
  state.nonLocalization = state.all.filter((symbol) => symbol.kind !== "localization-reference");
  state.allByFirstChar = buildPreferredByFirstChar(state.all);
  state.nonLocalizationByFirstChar = buildPreferredByFirstChar(state.nonLocalization);
  state.preferredAll = preferredAll;
  state.preferredNonLocalization = preferredNonLocalization;
  state.preferredByFirstChar = buildPreferredByFirstChar(preferredAll);
  state.preferredNonLocalizationByFirstChar = buildPreferredByFirstChar(preferredNonLocalization);
}

function updateDerivedReferencesForLiveChange(
  state: DerivedReferenceState,
  previous: LiveDocumentRecord | undefined,
  next: LiveDocumentRecord | undefined,
): void {
  for (const reference of previous?.references ?? []) {
    const existing = state.byName.get(reference.name);
    if (!existing) {
      continue;
    }
    const filtered = existing.filter((entry) => entry.path !== reference.path || entry.range.start.offset !== reference.range.start.offset);
    if (filtered.length === 0) {
      state.byName.delete(reference.name);
    } else {
      state.byName.set(reference.name, filtered);
    }
  }
  for (const reference of next?.references ?? []) {
    const existing = state.byName.get(reference.name) ?? [];
    existing.push(reference);
    state.byName.set(reference.name, existing);
  }
}

function flattenSymbolMap(byName: Map<string, SymbolRecord[]>): SymbolRecord[] {
  const all: SymbolRecord[] = [];
  for (const symbols of byName.values()) {
    all.push(...symbols);
  }
  return all;
}

function buildSymbolPositionMap(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const grouped = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    const key = toPositionKey(symbol.range.start.line, symbol.range.start.character);
    const existing = grouped.get(key) ?? [];
    existing.push(symbol);
    grouped.set(key, existing);
  }
  return grouped;
}

function buildReferencePositionMap(references: ReferenceRecord[]): Map<string, ReferenceRecord[]> {
  const grouped = new Map<string, ReferenceRecord[]>();
  for (const reference of references) {
    const key = toPositionKey(reference.range.start.line, reference.range.start.character);
    const existing = grouped.get(key) ?? [];
    existing.push(reference);
    grouped.set(key, existing);
  }
  return grouped;
}

function groupSymbolsByPosition(groupedByPath: Map<string, SymbolRecord[]>): Map<string, Map<string, SymbolRecord[]>> {
  const result = new Map<string, Map<string, SymbolRecord[]>>();
  for (const [filePath, symbols] of groupedByPath.entries()) {
    result.set(filePath, buildSymbolPositionMap(symbols));
  }
  return result;
}

function groupReferencesByPosition(groupedByPath: Map<string, ReferenceRecord[]>): Map<string, Map<string, ReferenceRecord[]>> {
  const result = new Map<string, Map<string, ReferenceRecord[]>>();
  for (const [filePath, references] of groupedByPath.entries()) {
    result.set(filePath, buildReferencePositionMap(references));
  }
  return result;
}

function toPositionKey(line: number, character: number): string {
  return `${line}:${character}`;
}

function diagnosticDependencyTags(
  documentUri: string,
  symbols: SymbolRecord[],
  references: ReferenceRecord[],
): string[] {
  return buildDocumentDependencies(documentUri, symbols, references).diagnosticTags;
}

function buildDocumentDependencies(
  documentUri: string,
  symbols: SymbolRecord[],
  references: ReferenceRecord[],
): { referencedNames: string[]; diagnosticTags: string[] } {
  const filePath = documentUri === "<in-memory>" ? null : uriToFsPath(documentUri);
  const names = new Set<string>();
  const tags = new Set<string>([
    "diagnostics",
    `diagnostics:${documentUri}`,
  ]);
  if (filePath) {
    tags.add(`path:${filePath}`);
  }

  for (const symbol of symbols) {
    names.add(symbol.name);
    tags.add(`symbol:${symbol.name}`);
    tags.add(`definition:${symbol.name}`);
  }
  for (const reference of references) {
    names.add(reference.name);
    tags.add(`reference:${reference.name}`);
    tags.add(`symbol:${reference.name}`);
    tags.add(`definition:${reference.name}`);
  }

  return {
    referencedNames: [...names],
    diagnosticTags: [...tags],
  };
}

function collectReferencedNames(symbols: SymbolRecord[], references: ReferenceRecord[]): string[] {
  return buildDocumentDependencies("<in-memory>", symbols, references).referencedNames;
}

function cloneDerivedSymbolState(state: DerivedSymbolState): DerivedSymbolState {
  const byName = new Map<string, SymbolRecord[]>();
  for (const [name, entries] of state.byName.entries()) {
    byName.set(name, [...entries]);
  }
  return {
    revision: state.revision,
    byName,
    all: [...state.all],
    nonLocalization: [...state.nonLocalization],
    allByFirstChar: cloneSymbolArrayMap(state.allByFirstChar),
    nonLocalizationByFirstChar: cloneSymbolArrayMap(state.nonLocalizationByFirstChar),
    preferredAll: [...state.preferredAll],
    preferredNonLocalization: [...state.preferredNonLocalization],
    preferredByFirstChar: cloneSymbolArrayMap(state.preferredByFirstChar),
    preferredNonLocalizationByFirstChar: cloneSymbolArrayMap(state.preferredNonLocalizationByFirstChar),
  };
}

function cloneDerivedReferenceState(state: DerivedReferenceState): DerivedReferenceState {
  const byName = new Map<string, ReferenceRecord[]>();
  for (const [name, entries] of state.byName.entries()) {
    byName.set(name, [...entries]);
  }
  return {
    revision: state.revision,
    byName,
  };
}

function cloneLiveDocuments(records: Map<string, LiveDocumentRecord>): Map<string, LiveDocumentRecord> {
  const cloned = new Map<string, LiveDocumentRecord>();
  for (const [uri, record] of records.entries()) {
    cloned.set(uri, {
      ...record,
      parsed: cloneParsedDocument(record.parsed),
      symbols: [...record.symbols],
      references: [...record.references],
      symbolPositions: cloneSymbolArrayMap(record.symbolPositions),
      referencePositions: cloneReferenceArrayMap(record.referencePositions),
      referencedNames: [...record.referencedNames],
      diagnosticTags: [...record.diagnosticTags],
    });
  }
  return cloned;
}

function cloneParsedDocumentMap(records: Map<string, ParsedDocument>): Map<string, ParsedDocument> {
  const cloned = new Map<string, ParsedDocument>();
  for (const [filePath, parsed] of records.entries()) {
    cloned.set(filePath, cloneParsedDocument(parsed));
  }
  return cloned;
}

function cloneParsedDocument(document: ParsedDocument): ParsedDocument {
  if (document.kind === "localization") {
    return {
      ...document,
      entries: document.entries.map((entry) => ({ ...entry, range: cloneRange(entry.range) })),
      errors: document.errors.map((error) => ({ ...error, range: cloneRange(error.range) })),
    };
  }

  return {
    ...document,
    entries: document.entries.map(cloneAssignment),
    errors: document.errors.map((error) => ({ ...error, range: cloneRange(error.range) })),
    tokens: document.tokens.map((token) => ({ ...token })),
  };
}

function cloneAssignment(entry: AssignmentNode): AssignmentNode {
  return {
    ...entry,
    keyRange: cloneRange(entry.keyRange),
    operatorRange: cloneRange(entry.operatorRange),
    range: cloneRange(entry.range),
    value: cloneValue(entry.value),
  };
}

function cloneValue(value: ValueNode): ValueNode {
  if (value.kind === "object") {
    return {
      ...value,
      entries: value.entries.map(cloneAssignment),
      range: cloneRange(value.range),
    };
  }
  if (value.kind === "list") {
    return {
      ...value,
      items: value.items.map(cloneValue),
      range: cloneRange(value.range),
    };
  }
  return { ...value, range: cloneRange(value.range) };
}

function cloneRange(range: ParsedRange): ParsedRange {
  return {
    start: { ...range.start },
    end: { ...range.end },
  };
}

export class ServerSnapshot {
  private readonly pathLinesCache = new Map<string, string[]>();
  private readonly localizationEntryCache = new Map<string, Map<string, string>>();

  constructor(
    private readonly view: {
      indexReady: boolean;
      indexRevision: number;
      lastIndexError: string | null;
      symbolState: DerivedSymbolState;
      referenceState: DerivedReferenceState;
      indexedSymbolPositionsByPath: Map<string, Map<string, SymbolRecord[]>>;
      indexedReferencePositionsByPath: Map<string, Map<string, ReferenceRecord[]>>;
      liveDocuments: Map<string, LiveDocumentRecord>;
      parsedByUri: Map<string, ParsedDocument>;
      parsedByPath: Map<string, ParsedDocument>;
      hoverCache: Map<string, Hover | null>;
      inlayHintCache: Map<string, VersionedCacheEntry<InlayHint[]>>;
      semanticTokenCache: Map<string, VersionedCacheEntry<SemanticTokens>>;
    },
  ) {}

  isIndexReady(): boolean {
    return this.view.indexReady;
  }

  getLastIndexError(): string | null {
    return this.view.lastIndexError;
  }

  getIndexRevision(): number {
    return this.view.indexRevision;
  }

  getHoverCache(key: string): Hover | null | undefined {
    return this.view.hoverCache.get(key);
  }

  parsedDocumentForUri(uri: string): ParsedDocument | undefined {
    return this.view.parsedByUri.get(uri);
  }

  symbolsByName(name: string, context?: RequestContext): SymbolRecord[] {
    context?.checkpoint();
    return this.view.symbolState.byName.get(name) ?? [];
  }

  referencesByName(name: string, context?: RequestContext): ReferenceRecord[] {
    context?.checkpoint();
    return this.view.referenceState.byName.get(name) ?? [];
  }

  definitionSymbols(name: string, context?: RequestContext): SymbolRecord[] {
    context?.checkpoint();
    return this.symbolsByName(name, context)
      .filter((symbol) => symbol.kind !== "localization-reference")
      .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod"));
  }

  preferredDefinition(name: string, context?: RequestContext): SymbolRecord | undefined {
    return this.definitionSymbols(name, context)[0];
  }

  workspaceSymbols(query?: string, context?: RequestContext): SymbolRecord[] {
    context?.checkpoint();
    if (!query) {
      return this.view.symbolState.preferredNonLocalization;
    }
    const lowered = query.toLowerCase();
    const pool = this.candidateSymbolsForQuery(
      this.view.symbolState.preferredNonLocalizationByFirstChar,
      this.view.symbolState.preferredNonLocalization,
      lowered,
    );
    return pool.filter((symbol, index) => {
      if (index % 256 === 0) {
        context?.checkpoint();
      }
      return symbol.name.toLowerCase().includes(lowered);
    });
  }

  allSymbols(query?: string, context?: RequestContext): SymbolRecord[] {
    context?.checkpoint();
    if (!query) {
      return this.view.symbolState.all;
    }
    const lowered = query.toLowerCase();
    const pool = this.candidateSymbolsForQuery(
      this.view.symbolState.allByFirstChar,
      this.view.symbolState.all,
      lowered,
    );
    return pool.filter((symbol, index) => {
      if (index % 256 === 0) {
        context?.checkpoint();
      }
      return symbol.name.toLowerCase().includes(lowered);
    });
  }

  completionSymbols(kinds: string[], query = "", limit = 100, context?: RequestContext): SymbolRecord[] {
    const lowered = query.toLowerCase();
    const pool = this.candidateSymbolsForQuery(
      this.view.symbolState.preferredByFirstChar,
      this.view.symbolState.preferredAll,
      lowered,
    );
    const matches: SymbolRecord[] = [];
    let inspected = 0;

    for (const candidate of pool) {
      if (inspected % 128 === 0) {
        context?.checkpoint();
      }
      inspected += 1;
      if (!symbolMatchesCompletionKinds(candidate.kind, kinds)) {
        continue;
      }
      if (lowered && !candidate.name.toLowerCase().includes(lowered)) {
        continue;
      }
      matches.push(candidate);
    }

    matches.sort((left, right) => {
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      const leftStarts = lowered ? leftName.startsWith(lowered) : false;
      const rightStarts = lowered ? rightName.startsWith(lowered) : false;
      if (leftStarts !== rightStarts) {
        return Number(rightStarts) - Number(leftStarts);
      }
      if (left.source !== right.source) {
        return Number(right.source === "mod") - Number(left.source === "mod");
      }
      return left.name.localeCompare(right.name);
    });

    return matches.slice(0, limit);
  }

  overlaySymbols(documentUri: string, symbols: SymbolRecord[], names: Set<string>, context?: RequestContext): Map<string, SymbolRecord[]> {
    const merged = new Map<string, SymbolRecord[]>();
    let processed = 0;

    for (const name of names) {
      if (processed % 128 === 0) {
        context?.checkpoint();
      }
      processed += 1;
      const entries = (this.symbolsByName(name, context) ?? [])
        .filter((entry) => pathToFileURL(entry.path).toString() !== documentUri);
      if (entries.length > 0) {
        merged.set(name, [...entries]);
      }
    }

    for (const entry of symbols) {
      if (!names.has(entry.name)) {
        continue;
      }
      const existing = merged.get(entry.name) ?? [];
      existing.push(entry);
      merged.set(entry.name, existing);
    }

    return merged;
  }

  renameCandidate(documentUri: string, position: { line: number; character: number }, name: string, context?: RequestContext): RenameCandidate | null {
    const filePath = uriToFsPath(documentUri);
    const live = this.view.liveDocuments.get(documentUri);
    const positionKey = toPositionKey(position.line, position.character);
    const symbols = (live?.symbolPositions.get(positionKey) ?? []).filter((symbol) => symbol.name === name);
    if (symbols.length > 0) {
      return { kind: symbols[0].kind, source: symbols[0].source };
    }

    context?.checkpoint();
    const baseSymbols = (this.view.indexedSymbolPositionsByPath.get(filePath)?.get(positionKey) ?? [])
      .filter((symbol) => symbol.name === name);
    if (baseSymbols.length > 0) {
      return { kind: baseSymbols[0].kind, source: baseSymbols[0].source };
    }

    const references = (live?.referencePositions.get(positionKey) ?? []).filter((reference) => reference.name === name);
    if (references.length > 0) {
      return { kind: referenceKind(references[0]), source: references[0].source };
    }

    context?.checkpoint();
    const baseReferences = (this.view.indexedReferencePositionsByPath.get(filePath)?.get(positionKey) ?? [])
      .filter((reference) => reference.name === name);
    if (baseReferences.length > 0) {
      return { kind: referenceKind(baseReferences[0]), source: baseReferences[0].source };
    }

    return null;
  }

  symbolSnippet(symbol: SymbolRecord): string | undefined {
    const lines = this.pathLines(symbol.path);
    if (!lines) {
      return undefined;
    }
    const startLine = Math.max(symbol.range.start.line - 1, 0);
    const endLine = Math.min(symbol.range.end.line + 1, lines.length - 1);
    return lines.slice(startLine, endLine + 1).join("\n").trim();
  }

  localizationText(symbol: SymbolRecord): string | undefined {
    if (symbol.kind !== "localization") {
      return undefined;
    }
    return this.localizationEntries(symbol.path)?.get(symbol.name);
  }

  localizationLanguage(symbol: SymbolRecord): string | null | undefined {
    if (symbol.kind !== "localization") {
      return undefined;
    }
    const parsed = this.view.parsedByPath.get(symbol.path);
    if (!parsed || parsed.kind !== "localization") {
      return undefined;
    }
    return parsed.language;
  }

  private pathLines(filePath: string): string[] | undefined {
    const cached = this.pathLinesCache.get(filePath);
    if (cached) {
      return cached;
    }
    const text = this.view.parsedByPath.get(filePath)?.text;
    if (!text) {
      return undefined;
    }
    const lines = text.split(/\r?\n/);
    this.pathLinesCache.set(filePath, lines);
    return lines;
  }

  private localizationEntries(filePath: string): Map<string, string> | undefined {
    const cached = this.localizationEntryCache.get(filePath);
    if (cached) {
      return cached;
    }
    const parsed = this.view.parsedByPath.get(filePath);
    if (!parsed || parsed.kind !== "localization") {
      return undefined;
    }
    const entries = new Map<string, string>();
    for (const entry of parsed.entries) {
      entries.set(entry.key, entry.value);
    }
    this.localizationEntryCache.set(filePath, entries);
    return entries;
  }

  private candidateSymbolsForQuery(
    byFirstChar: Map<string, SymbolRecord[]>,
    fallback: SymbolRecord[],
    lowered: string,
  ): SymbolRecord[] {
    if (!lowered) {
      return fallback;
    }
    return byFirstChar.get(lowered[0]) ?? fallback;
  }

  inlayHintCache(uri: string, version: number): InlayHint[] | undefined {
    const cached = this.view.inlayHintCache.get(uri);
    if (cached && cached.version === version && cached.indexRevision === this.view.indexRevision) {
      return cached.value;
    }
    return undefined;
  }

  semanticTokenCache(uri: string, version: number): SemanticTokens | undefined {
    const cached = this.view.semanticTokenCache.get(uri);
    if (cached && cached.version === version && cached.indexRevision === this.view.indexRevision) {
      return cached.value;
    }
    return undefined;
  }
}
