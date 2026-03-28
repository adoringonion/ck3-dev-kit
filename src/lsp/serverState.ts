import * as path from "path";
import { pathToFileURL } from "url";
import { Diagnostic, DiagnosticSeverity, Hover } from "vscode-languageserver/node";
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

  private liveDocuments = new Map<string, LiveDocumentRecord>();
  private diagnosticCache = new Map<string, DiagnosticCacheEntry>();
  private hoverCache = new Map<string, Hover | null>();
  private diagnosticTimers = new Map<string, NodeJS.Timeout>();
  private workspaceDiagnosticRun = 0;
  private indexRevision = 0;
  private indexReady = false;
  private lastIndexError: string | null = null;

  setConfig(config: ServerConfig): void {
    this.config = config;
  }

  getConfig(): ServerConfig {
    return this.config;
  }

  setIndex(index: WorkspaceIndex): void {
    this.index = index;
    this.indexRevision += 1;
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

  setLiveDocument(document: TextDocument, source: SourceKind): LiveDocumentRecord {
    const filePath = uriToFsPath(document.uri);
    const record = {
      ...createDocumentIndexRecord(filePath, document.getText(), source),
      source,
    };
    this.liveDocuments.set(document.uri, record);
    return record;
  }

  deleteLiveDocument(uri: string): void {
    this.liveDocuments.delete(uri);
    this.deleteDiagnosticCache(uri);
    this.clearHoverCacheForUri(uri);
  }

  getLiveDocument(uri: string): LiveDocumentRecord | undefined {
    return this.liveDocuments.get(uri);
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

  clearTransientState(): void {
    this.diagnosticCache.clear();
    this.hoverCache.clear();
    this.cancelAllDocumentDiagnostics();
    this.cancelWorkspaceDiagnostics();
  }

  symbolsByName(name: string): SymbolRecord[] {
    const liveUris = new Set(this.liveDocuments.keys());
    const base = (this.index.symbols.get(name) ?? []).filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
    const live = Array.from(this.liveDocuments.values())
      .flatMap((record) => record.symbols)
      .filter((entry) => entry.name === name);
    return [...base, ...live];
  }

  referencesByName(name: string): ReferenceRecord[] {
    const liveUris = new Set(this.liveDocuments.keys());
    const base = (this.index.references.get(name) ?? []).filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
    const live = Array.from(this.liveDocuments.values())
      .flatMap((record) => record.references)
      .filter((entry) => entry.name === name);
    return [...base, ...live];
  }

  allSymbols(query?: string): SymbolRecord[] {
    const liveUris = new Set(this.liveDocuments.keys());
    const base = Array.from(this.index.symbols.values())
      .flat()
      .filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
    const live = Array.from(this.liveDocuments.values()).flatMap((record) => record.symbols);
    const merged = [...base, ...live];
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

  syncDocument(document: TextDocument): LiveDocumentRecord | null {
    const filePath = uriToFsPath(document.uri);
    if (!matchesCk3Path(filePath)) {
      this.deleteLiveDocument(document.uri);
      return null;
    }
    const source = this.resolveSource(filePath);
    return this.setLiveDocument(document, source);
  }

  collectDocumentDiagnostics(document: TextDocument): Diagnostic[] {
    const cached = this.getDiagnosticCache(document.uri);
    if (cached && cached.version === document.version && cached.indexRevision === this.indexRevision) {
      return cached.diagnostics;
    }

    const filePath = uriToFsPath(document.uri);
    const live = this.getLiveDocument(document.uri) ?? this.syncDocument(document) ?? {
      ...createDocumentIndexRecord(filePath, document.getText(), this.resolveSource(filePath)),
      source: this.resolveSource(filePath),
    };
    const diagnostics = this.collectValidationDiagnostics(filePath, live.parsed, live.symbols, live.references);
    this.setDiagnosticCache(document.uri, document.version, diagnostics);
    return diagnostics;
  }

  collectIndexedDiagnostics(filePath: string, parsed: ParsedDocument): Diagnostic[] {
    return this.collectValidationDiagnostics(filePath, parsed);
  }

  completionSymbols(kinds: string[], query = "", limit = 100): SymbolRecord[] {
    const lowered = query.toLowerCase();
    const matches: SymbolRecord[] = [];
    const grouped = new Map<string, SymbolRecord[]>();

    for (const symbol of this.allSymbols()) {
      const existing = grouped.get(symbol.name) ?? [];
      existing.push(symbol);
      grouped.set(symbol.name, existing);
    }

    for (const records of grouped.values()) {
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

    return matches.slice(0, limit);
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
    return this.allSymbols(query).filter((symbol) => symbol.kind !== "localization-reference");
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
