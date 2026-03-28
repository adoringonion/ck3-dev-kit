import * as path from "path";
import { pathToFileURL } from "url";
import { Diagnostic, DiagnosticSeverity, Hover, InlayHint, SemanticTokens } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createDocumentIndexRecord, WorkspaceIndex } from "../core/indexer";
import { collectParsedReferences, validateParsedReferencesAgainstIndex } from "../core/references";
import { ParsedDocument, Range as ParsedRange, ReferenceRecord, SymbolRecord } from "../core/types";

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
}

interface DerivedReferenceState {
  revision: number;
  byName: Map<string, ReferenceRecord[]>;
}

export class ServerState {
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

  private liveDocuments = new Map<string, LiveDocumentRecord>();
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
  private completionQueryCache = new Map<string, SymbolRecord[]>();
  private workspaceSymbolQueryCache = new Map<string, SymbolRecord[]>();

  setConfig(config: ServerConfig): void {
    this.config = config;
  }

  getConfig(): ServerConfig {
    return this.config;
  }

  setIndex(index: WorkspaceIndex): void {
    this.index = index;
    this.indexedSymbolsByPath = groupSymbolsByPath(index.symbols);
    this.indexedReferencesByPath = groupReferencesByPath(index.references);
    this.indexRevision += 1;
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
    return new ServerSnapshot(this);
  }

  setLiveDocument(document: TextDocument, source: SourceKind): LiveDocumentRecord {
    const filePath = uriToFsPath(document.uri);
    const record = {
      version: document.version,
      ...createDocumentIndexRecord(filePath, document.getText(), source),
      source,
    };
    this.liveDocuments.set(document.uri, record);
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
      source,
    };
    this.liveDocuments.set(document.uri, record);
    this.bumpStateRevision();
    this.clearDocumentFeatureCaches(document.uri);
    return record;
  }

  deleteLiveDocument(uri: string): void {
    if (this.liveDocuments.delete(uri)) {
      this.bumpStateRevision();
    }
    this.deleteDiagnosticCache(uri);
    this.clearDocumentFeatureCaches(uri);
  }

  getLiveDocument(uri: string): LiveDocumentRecord | undefined {
    return this.liveDocuments.get(uri);
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

  symbolsByName(name: string): SymbolRecord[] {
    return this.getDerivedSymbols().byName.get(name) ?? [];
  }

  referencesByName(name: string): ReferenceRecord[] {
    return this.getDerivedReferences().byName.get(name) ?? [];
  }

  allSymbols(query?: string): SymbolRecord[] {
    const merged = this.getDerivedSymbols().all;
    if (!query) {
      return merged;
    }
    const lowered = query.toLowerCase();
    return merged.filter((symbol) => symbol.name.toLowerCase().includes(lowered));
  }

  overlaySymbols(documentUri: string, symbols: SymbolRecord[], names: Set<string>): Map<string, SymbolRecord[]> {
    const liveUris = new Set(this.liveDocuments.keys());
    liveUris.add(documentUri);
    const merged = new Map<string, SymbolRecord[]>();

    for (const name of names) {
      const entries = this.index.symbols.get(name) ?? [];
      const filtered = entries.filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
      if (filtered.length > 0) {
        merged.set(name, filtered);
      }
    }

    for (const [uri, record] of this.liveDocuments.entries()) {
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
    if (this.liveDocuments.delete(document.uri)) {
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
    const record: LiveDocumentRecord = {
      version,
      parsed,
      symbols,
      references,
      source,
    };
    this.liveDocuments.set(uri, record);
    this.bumpStateRevision();
    this.deleteDiagnosticCache(uri);
    this.clearDocumentFeatureCaches(uri);
    return record;
  }

  collectDocumentDiagnostics(document: TextDocument): Diagnostic[] {
    const cached = this.getDiagnosticCache(document.uri);
    if (cached && cached.version === document.version && cached.indexRevision === this.indexRevision) {
      return cached.diagnostics;
    }

    const filePath = uriToFsPath(document.uri);
    const live = this.getLiveDocument(document.uri);
    if (!live || live.version !== document.version) {
      return [];
    }
    const diagnostics = this.collectValidationDiagnostics(filePath, live.parsed, live.symbols, live.references);
    this.setDiagnosticCache(document.uri, document.version, diagnostics);
    return diagnostics;
  }

  collectIndexedDiagnostics(filePath: string, parsed: ParsedDocument): Diagnostic[] {
    return this.collectValidationDiagnostics(filePath, parsed);
  }

  completionSymbols(kinds: string[], query = "", limit = 100): SymbolRecord[] {
    const normalizedKinds = [...kinds].sort().join(",");
    const cacheKey = `${normalizedKinds}::${query.toLowerCase()}::${limit}`;
    const cached = this.completionQueryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const lowered = query.toLowerCase();
    const matches: SymbolRecord[] = [];
    for (const records of this.getDerivedSymbols().byName.values()) {
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
    this.completionQueryCache.set(cacheKey, result);
    return result;
  }

  definitionSymbols(name: string): SymbolRecord[] {
    return this.symbolsByName(name)
      .filter((symbol) => symbol.kind !== "localization-reference")
      .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod"));
  }

  preferredDefinition(name: string): SymbolRecord | undefined {
    return this.definitionSymbols(name)[0];
  }

  workspaceSymbols(query?: string): SymbolRecord[] {
    const cacheKey = query?.toLowerCase() ?? "";
    const cached = this.workspaceSymbolQueryCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const result = this.allSymbols(query).filter((symbol) => symbol.kind !== "localization-reference");
    this.workspaceSymbolQueryCache.set(cacheKey, result);
    return result;
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

  renameCandidate(documentUri: string, position: { line: number; character: number }, name: string): RenameCandidate | null {
    const filePath = uriToFsPath(documentUri);
    const live = this.getLiveDocument(documentUri);
    const symbols = (live?.symbols ?? []).filter((symbol) =>
      symbol.name === name &&
      symbol.range.start.line === position.line &&
      symbol.range.start.character === position.character
    );
    if (symbols.length > 0) {
      return { kind: symbols[0].kind, source: symbols[0].source };
    }

    const baseSymbols = (this.index.symbols.get(name) ?? []).filter((symbol) =>
      symbol.path === filePath &&
      symbol.range.start.line === position.line &&
      symbol.range.start.character === position.character
    );
    if (baseSymbols.length > 0) {
      return { kind: baseSymbols[0].kind, source: baseSymbols[0].source };
    }

    const references = (live?.references ?? []).filter((reference) =>
      reference.name === name &&
      reference.range.start.line === position.line &&
      reference.range.start.character === position.character
    );
    if (references.length > 0) {
      return { kind: referenceKind(references[0]), source: references[0].source };
    }

    const baseReferences = (this.index.references.get(name) ?? []).filter((reference) =>
      reference.path === filePath &&
      reference.range.start.line === position.line &&
      reference.range.start.character === position.character
    );
    if (baseReferences.length > 0) {
      return { kind: referenceKind(baseReferences[0]), source: baseReferences[0].source };
    }

    return null;
  }

  symbolSnippet(symbol: SymbolRecord): string | undefined {
    const text = this.getParsedDocumentForPath(symbol.path)?.text;
    if (!text) {
      return undefined;
    }
    const lines = text.split(/\r?\n/);
    const startLine = Math.max(symbol.range.start.line - 1, 0);
    const endLine = Math.min(symbol.range.end.line + 1, lines.length - 1);
    return lines.slice(startLine, endLine + 1).join("\n").trim();
  }

  localizationText(symbol: SymbolRecord): string | undefined {
    if (symbol.kind !== "localization") {
      return undefined;
    }
    const parsed = this.getParsedDocumentForPath(symbol.path);
    if (!parsed || parsed.kind !== "localization") {
      return undefined;
    }
    return parsed.entries.find((entry) => entry.key === symbol.name)?.value;
  }

  localizationLanguage(symbol: SymbolRecord): string | null | undefined {
    if (symbol.kind !== "localization") {
      return undefined;
    }
    const parsed = this.getParsedDocumentForPath(symbol.path);
    if (!parsed || parsed.kind !== "localization") {
      return undefined;
    }
    return parsed.language;
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
    }
  ): void {
    const initialDelayMs = options?.initialDelayMs ?? 5000;
    const batchBudgetMs = options?.batchBudgetMs ?? 8;
    const batchIntervalMs = options?.batchIntervalMs ?? 100;
    const runId = ++this.workspaceDiagnosticRun;
    let cursor = 0;

    const processBatch = () => {
      if (runId !== this.workspaceDiagnosticRun) {
        return;
      }
      const started = Date.now();
      while (cursor < entries.length && Date.now() - started < batchBudgetMs) {
        processEntry(entries[cursor]);
        cursor += 1;
      }

      if (cursor < entries.length) {
        setTimeout(processBatch, batchIntervalMs);
      }
    };

    setTimeout(processBatch, initialDelayMs);
  }

  cancelWorkspaceDiagnostics(): void {
    this.workspaceDiagnosticRun += 1;
  }

  private bumpStateRevision(): void {
    this.stateRevision += 1;
    this.derivedSymbols = null;
    this.derivedReferences = null;
    this.completionQueryCache.clear();
    this.workspaceSymbolQueryCache.clear();
  }

  private getDerivedSymbols(): DerivedSymbolState {
    if (this.derivedSymbols && this.derivedSymbols.revision === this.stateRevision) {
      return this.derivedSymbols;
    }
    const liveUris = new Set(this.liveDocuments.keys());
    const byName = new Map<string, SymbolRecord[]>();
    const all: SymbolRecord[] = [];

    for (const [name, entries] of this.index.symbols.entries()) {
      const filtered = entries.filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
      if (filtered.length === 0) {
        continue;
      }
      byName.set(name, [...filtered]);
      all.push(...filtered);
    }

    for (const record of this.liveDocuments.values()) {
      for (const entry of record.symbols) {
        const existing = byName.get(entry.name) ?? [];
        existing.push(entry);
        byName.set(entry.name, existing);
        all.push(entry);
      }
    }

    this.derivedSymbols = {
      revision: this.stateRevision,
      byName,
      all,
    };
    return this.derivedSymbols;
  }

  private getDerivedReferences(): DerivedReferenceState {
    if (this.derivedReferences && this.derivedReferences.revision === this.stateRevision) {
      return this.derivedReferences;
    }
    const liveUris = new Set(this.liveDocuments.keys());
    const byName = new Map<string, ReferenceRecord[]>();

    for (const [name, entries] of this.index.references.entries()) {
      const filtered = entries.filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
      if (filtered.length > 0) {
        byName.set(name, [...filtered]);
      }
    }

    for (const record of this.liveDocuments.values()) {
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
  }

  private collectValidationDiagnostics(
    filePath: string,
    parsed: ParsedDocument,
    liveSymbols?: SymbolRecord[],
    liveReferences?: ReferenceRecord[]
  ): Diagnostic[] {
    const symbols = liveSymbols ?? createDocumentIndexRecord(filePath, parsed.text, this.resolveSource(filePath)).symbols;
    const references = liveReferences ?? collectParsedReferences(parsed);
    const referencedNames = new Set(references.map((reference) => reference.name));
    for (const symbol of symbols) {
      referencedNames.add(symbol.name);
    }
    const overlayedSymbols = this.overlaySymbols(pathToFileURL(filePath).toString(), symbols, referencedNames);
    const validation = validateParsedReferencesAgainstIndex(parsed, references, {
      ...this.index,
      symbols: overlayedSymbols,
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

export class ServerSnapshot {
  constructor(private readonly state: ServerState) {}

  isIndexReady(): boolean {
    return this.state.isIndexReady();
  }

  getLastIndexError(): string | null {
    return this.state.getLastIndexError();
  }

  getHoverCache(key: string): Hover | null | undefined {
    return this.state.getHoverCache(key);
  }

  setHoverCache(key: string, hover: Hover | null): void {
    this.state.setHoverCache(key, hover);
  }

  parsedDocumentForUri(uri: string): ParsedDocument | undefined {
    return this.state.getParsedDocumentForUri(uri);
  }

  symbolsByName(name: string): SymbolRecord[] {
    return this.state.symbolsByName(name);
  }

  referencesByName(name: string): ReferenceRecord[] {
    return this.state.referencesByName(name);
  }

  definitionSymbols(name: string): SymbolRecord[] {
    return this.state.definitionSymbols(name);
  }

  workspaceSymbols(query?: string): SymbolRecord[] {
    return this.state.workspaceSymbols(query);
  }

  allSymbols(query?: string): SymbolRecord[] {
    return this.state.allSymbols(query);
  }

  completionSymbols(kinds: string[], query = "", limit = 100): SymbolRecord[] {
    return this.state.completionSymbols(kinds, query, limit);
  }

  renameCandidate(documentUri: string, position: { line: number; character: number }, name: string): RenameCandidate | null {
    return this.state.renameCandidate(documentUri, position, name);
  }

  symbolSnippet(symbol: SymbolRecord): string | undefined {
    return this.state.symbolSnippet(symbol);
  }

  localizationText(symbol: SymbolRecord): string | undefined {
    return this.state.localizationText(symbol);
  }

  localizationLanguage(symbol: SymbolRecord): string | null | undefined {
    return this.state.localizationLanguage(symbol);
  }

  inlayHintCache(uri: string, version: number): InlayHint[] | undefined {
    return this.state.getInlayHintCache(uri, version);
  }

  setInlayHintCache(uri: string, version: number, hints: InlayHint[]): void {
    this.state.setInlayHintCache(uri, version, hints);
  }

  semanticTokenCache(uri: string, version: number): SemanticTokens | undefined {
    return this.state.getSemanticTokenCache(uri, version);
  }

  setSemanticTokenCache(uri: string, version: number, tokens: SemanticTokens): void {
    this.state.setSemanticTokenCache(uri, version, tokens);
  }
}
