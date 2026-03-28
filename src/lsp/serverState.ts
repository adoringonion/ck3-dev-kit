import * as path from "path";
import { pathToFileURL } from "url";
import { Hover } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createDocumentIndexRecord, WorkspaceIndex } from "../core/indexer";
import { ParsedDocument, ReferenceRecord, SymbolRecord } from "../core/types";

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

interface DiagnosticCacheEntry<TDiagnostic> {
  version: number;
  indexRevision: number;
  diagnostics: TDiagnostic[];
}

export class ServerState<TDiagnostic> {
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
  private diagnosticCache = new Map<string, DiagnosticCacheEntry<TDiagnostic>>();
  private hoverCache = new Map<string, Hover | null>();
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

  getDiagnosticCache(uri: string): DiagnosticCacheEntry<TDiagnostic> | undefined {
    return this.diagnosticCache.get(uri);
  }

  setDiagnosticCache(uri: string, version: number, diagnostics: TDiagnostic[]): void {
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
