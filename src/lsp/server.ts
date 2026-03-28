import {
  CompletionItem,
  CompletionItemKind,
  CompletionParams,
  createConnection,
  Definition,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  MarkupKind,
  Position,
  Range,
  ReferenceParams,
  SymbolInformation,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceSymbolParams,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as path from "path";
import { pathToFileURL } from "url";
import { createDocumentIndexRecord, WorkspaceIndex } from "../core/indexer";
import { validateParsedDocumentAgainstIndex } from "../core/references";
import { parseDocumentText } from "../core/document";
import { scalarValue } from "../core/parser";
import { ParsedDocument, AssignmentNode, ReferenceRecord, SymbolRecord } from "../core/types";
import { buildCachedWorkspaceIndex } from "../cli-shared";
import { getScriptSyntaxHelp, SyntaxHelpContext } from "../extension/dynamicReferenceHelp";
import { inferCompletionContext } from "../extension/completion";

type SourceKind = "mod" | "reference";

interface ServerConfig {
  modRoots: string[];
  referenceRoots: string[];
  maxFiles: number;
}

interface LiveDocumentRecord {
  parsed: ParsedDocument;
  symbols: SymbolRecord[];
  references: ReferenceRecord[];
  source: SourceKind;
}

const connection = createConnection();
const documents = new TextDocuments(TextDocument);

let config: ServerConfig = {
  modRoots: [],
  referenceRoots: [],
  maxFiles: 20000,
};
let index: WorkspaceIndex = {
  symbols: new Map(),
  references: new Map(),
  documents: new Map(),
  files: [],
};
const liveDocuments = new Map<string, LiveDocumentRecord>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  config = normalizeConfig(params.initializationOptions);
  rebuildIndex();
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      completionProvider: {
        triggerCharacters: [".", ":", "="],
      },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
    },
  };
});

connection.onInitialized(() => {
  for (const document of documents.all()) {
    syncDocument(document);
    publishDiagnostics(document);
  }
});

connection.onHover(({ textDocument, position }): Hover | null => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }

  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }

  const parsed = parseDocumentText(uriToFsPath(document.uri), document.getText());
  const name = document.getText(wordRange);
  const syntaxHelp = getScriptSyntaxHelp(name, parsed.kind === "script" ? syntaxHelpContextAt(parsed, wordRange) : undefined);
  if (syntaxHelp) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${syntaxHelp.id}**\n\n${syntaxHelp.title}\n\n${syntaxHelp.summary}\n\n${syntaxHelp.details.join("\n\n")}`,
      },
      range: wordRange,
    };
  }

  const target = symbolsByName(name).find((item) => item.kind !== "localization-reference");
  if (!target) {
    return null;
  }

  const referenceCount = referencesByName(name).length;
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: `**${target.name}**\n\nType: \`${target.kind}\`\n\nSource: \`${target.source}\`\n\nReferences: \`${referenceCount}\`\n\nPath: \`${target.path}\``,
    },
    range: wordRange,
  };
});

connection.onDefinition(({ textDocument, position }): Definition | null => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }
  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }

  const name = document.getText(wordRange);
  const relevant = symbolsByName(name)
    .filter((symbol) => symbol.kind !== "localization-reference")
    .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod"));
  if (relevant.length === 0) {
    return null;
  }
  return relevant.map(toLocation);
});

connection.onReferences(({ textDocument, position }: ReferenceParams): Location[] | null => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }
  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }
  const name = document.getText(wordRange);
  return referencesByName(name).map(toReferenceLocation);
});

connection.onCompletion(({ textDocument, position }: CompletionParams): CompletionItem[] | null => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }

  const lines = document.getText().split(/\r?\n/);
  const currentLine = lines[position.line] ?? "";
  const linePrefix = currentLine.slice(0, position.character);
  const context = inferCompletionContext(linePrefix, recentDocumentText(document, position));
  if (!context) {
    return null;
  }

  const symbols = completionSymbols(context.kinds, context.query);
  return symbols.map((symbol) => ({
    label: context.prefix ? `${context.prefix}${symbol.name}` : symbol.name,
    kind: toCompletionItemKind(symbol),
    detail: `${symbol.kind} (${symbol.source})`,
    documentation: {
      kind: MarkupKind.Markdown,
      value: completionDocumentation(symbol),
    },
    textEdit: {
      range: findWordRange(document, position) ?? { start: position, end: position },
      newText: context.prefix ? `${context.prefix}${symbol.name}` : symbol.name,
    },
    sortText: `${symbol.source === "mod" ? "0" : "1"}-${symbol.name}`,
  }));
});

connection.onDocumentSymbol(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return [];
  }

  const parsed = parseDocumentText(uriToFsPath(document.uri), document.getText());
  if (parsed.kind !== "script") {
    return [];
  }

  return parsed.entries
    .filter((entry) => entry.value.kind === "object")
    .map((entry) => ({
      name: entry.key,
      detail: describeEntry(entry),
      kind: entry.key === "namespace"
        ? SymbolKind.Namespace
        : looksLikeEventId(entry.key)
          ? SymbolKind.Event
          : SymbolKind.Object,
      range: toLspRange(entry.range),
      selectionRange: toLspRange(entry.keyRange),
    }));
});

connection.onWorkspaceSymbol(({ query }: WorkspaceSymbolParams): SymbolInformation[] => {
  return allSymbols(query)
    .filter((symbol) => symbol.kind !== "localization-reference")
    .map((symbol) => ({
      name: symbol.name,
      kind: toSymbolKind(symbol),
      location: toLocation(symbol),
      containerName: symbol.containerName ?? "",
    }));
});

connection.onNotification("ck3/rebuildIndex", () => {
  rebuildIndex();
  for (const document of documents.all()) {
    syncDocument(document);
    publishDiagnostics(document);
  }
});

documents.onDidOpen((event) => {
  syncDocument(event.document);
  publishDiagnostics(event.document);
});

documents.onDidChangeContent((event) => {
  syncDocument(event.document);
  publishDiagnostics(event.document);
});

documents.onDidClose((event) => {
  liveDocuments.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();

function normalizeConfig(value: unknown): ServerConfig {
  if (!value || typeof value !== "object") {
    return config;
  }
  const candidate = value as Partial<ServerConfig>;
  return {
    modRoots: Array.isArray(candidate.modRoots) ? candidate.modRoots : [],
    referenceRoots: Array.isArray(candidate.referenceRoots) ? candidate.referenceRoots : [],
    maxFiles: typeof candidate.maxFiles === "number" ? candidate.maxFiles : 20000,
  };
}

function rebuildIndex(): void {
  index = buildCachedWorkspaceIndex(config);
}

function syncDocument(document: TextDocument): void {
  const filePath = uriToFsPath(document.uri);
  if (!matchesCk3Path(filePath)) {
    liveDocuments.delete(document.uri);
    return;
  }
  const source = resolveSource(filePath);
  liveDocuments.set(document.uri, {
    ...createDocumentIndexRecord(filePath, document.getText(), source),
    source,
  });
}

function publishDiagnostics(document: TextDocument): void {
  const live = liveDocuments.get(document.uri);
  if (!live) {
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    return;
  }

  const overlayedSymbols = overlaySymbols(document.uri, live.symbols);
  const validation = validateParsedDocumentAgainstIndex(live.parsed, {
    ...index,
    symbols: overlayedSymbols,
  });

  const diagnostics: Diagnostic[] = validation.map((entry) => ({
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

  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics,
  });
}

function overlaySymbols(documentUri: string, symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const liveUris = new Set(liveDocuments.keys());
  liveUris.add(documentUri);
  const merged = new Map<string, SymbolRecord[]>();

  for (const [name, entries] of index.symbols.entries()) {
    const filtered = entries.filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
    if (filtered.length > 0) {
      merged.set(name, filtered);
    }
  }

  for (const [uri, record] of liveDocuments.entries()) {
    if (uri === documentUri) {
      continue;
    }
    for (const entry of record.symbols) {
      const existing = merged.get(entry.name) ?? [];
      existing.push(entry);
      merged.set(entry.name, existing);
    }
  }

  for (const entry of symbols) {
    const existing = merged.get(entry.name) ?? [];
    existing.push(entry);
    merged.set(entry.name, existing);
  }

  return merged;
}

function symbolsByName(name: string): SymbolRecord[] {
  const liveUris = new Set(liveDocuments.keys());
  const base = (index.symbols.get(name) ?? []).filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
  const live = Array.from(liveDocuments.values())
    .flatMap((record) => record.symbols)
    .filter((entry) => entry.name === name);
  return [...base, ...live];
}

function referencesByName(name: string): ReferenceRecord[] {
  const liveUris = new Set(liveDocuments.keys());
  const base = (index.references.get(name) ?? []).filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
  const live = Array.from(liveDocuments.values())
    .flatMap((record) => record.references)
    .filter((entry) => entry.name === name);
  return [...base, ...live];
}

function allSymbols(query?: string): SymbolRecord[] {
  const liveUris = new Set(liveDocuments.keys());
  const base = Array.from(index.symbols.values())
    .flat()
    .filter((entry) => !liveUris.has(pathToFileURL(entry.path).toString()));
  const live = Array.from(liveDocuments.values()).flatMap((record) => record.symbols);
  const merged = [...base, ...live];
  if (!query) {
    return merged;
  }
  const lowered = query.toLowerCase();
  return merged.filter((symbol) => symbol.name.toLowerCase().includes(lowered));
}

function completionSymbols(kinds: string[], query = "", limit = 100): SymbolRecord[] {
  const lowered = query.toLowerCase();
  const matches: SymbolRecord[] = [];
  const grouped = new Map<string, SymbolRecord[]>();

  for (const symbol of allSymbols()) {
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

function findWordRange(document: TextDocument, position: Position): Range | null {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const isWord = (char: string) => /[\w.:-]/.test(char);

  let start = offset;
  while (start > 0 && isWord(text[start - 1])) {
    start -= 1;
  }

  let end = offset;
  while (end < text.length && isWord(text[end])) {
    end += 1;
  }

  if (start === end) {
    return null;
  }

  return {
    start: document.positionAt(start),
    end: document.positionAt(end),
  };
}

function syntaxHelpContextAt(parsed: ParsedDocument, range: Range): SyntaxHelpContext | undefined {
  if (parsed.kind !== "script") {
    return undefined;
  }
  return findEntryContext(parsed.entries, range, []);
}

function findEntryContext(entries: AssignmentNode[], range: Range, parents: string[]): SyntaxHelpContext | undefined {
  for (const entry of entries) {
    if (sameRange(entry.keyRange, range)) {
      return {
        isKey: true,
        parents,
      };
    }
    if (entry.value.kind !== "object") {
      continue;
    }
    const nested = findEntryContext(entry.value.entries, range, [...parents, entry.key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function sameRange(
  left: { start: { line: number; character: number }; end: { line: number; character: number } },
  right: Range
): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function toLspRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): Range {
  return {
    start: {
      line: range.start.line,
      character: range.start.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  };
}

function toLocation(symbol: SymbolRecord): Location {
  return {
    uri: pathToFileURL(symbol.path).toString(),
    range: toLspRange(symbol.range),
  };
}

function toReferenceLocation(reference: ReferenceRecord): Location {
  return {
    uri: pathToFileURL(reference.path).toString(),
    range: toLspRange(reference.range),
  };
}

function recentDocumentText(document: TextDocument, position: Position): string {
  const startLine = Math.max(position.line - 6, 0);
  const start = document.offsetAt({ line: startLine, character: 0 });
  const end = document.offsetAt(position);
  return document.getText().slice(start, end);
}

function symbolMatchesCompletionKinds(symbolKind: string, completionKinds: string[]): boolean {
  return completionKinds.some((kind) => {
    if (kind === "character_modifier" || kind === "county_modifier" || kind === "province_modifier" || kind === "artifact_modifier") {
      return symbolKind === "modifier";
    }
    return symbolKind === kind;
  });
}

function toSymbolKind(symbol: SymbolRecord): SymbolKind {
  switch (symbol.kind) {
    case "namespace":
      return SymbolKind.Namespace;
    case "event":
      return SymbolKind.Event;
    case "scripted_effect":
    case "scripted_trigger":
      return SymbolKind.Function;
    case "script_value":
      return SymbolKind.Variable;
    case "decision":
      return SymbolKind.Method;
    case "modifier":
      return SymbolKind.Constant;
    case "trait":
      return SymbolKind.EnumMember;
    case "culture":
    case "faith":
    case "religion":
      return SymbolKind.Class;
    case "cultural_tradition":
    case "cultural_pillar":
    case "doctrine":
      return SymbolKind.Enum;
    case "localization":
      return SymbolKind.String;
    default:
      return SymbolKind.Object;
  }
}

function toCompletionItemKind(symbol: SymbolRecord): CompletionItemKind {
  switch (symbol.kind) {
    case "event":
      return CompletionItemKind.Event;
    case "localization":
      return CompletionItemKind.Text;
    case "scripted_effect":
    case "scripted_trigger":
      return CompletionItemKind.Function;
    case "script_value":
      return CompletionItemKind.Variable;
    case "trait":
    case "doctrine":
    case "doctrine_parameter":
    case "cultural_tradition":
    case "cultural_pillar":
      return CompletionItemKind.EnumMember;
    case "modifier":
      return CompletionItemKind.Constant;
    case "culture":
    case "faith":
    case "religion":
      return CompletionItemKind.Class;
    case "artifact_type":
    case "artifact_template":
    case "artifact_visual":
      return CompletionItemKind.Value;
    default:
      return CompletionItemKind.Value;
  }
}

function completionDocumentation(symbol: SymbolRecord): string {
  const container = symbol.containerName ? `\n\nContainer: \`${symbol.containerName}\`` : "";
  return `**${symbol.name}**\n\nType: \`${symbol.kind}\`\n\nSource: \`${symbol.source}\`\n\nPath: \`${symbol.path}\`${container}`;
}

function describeEntry(entry: AssignmentNode): string {
  const value = scalarValue(entry.value);
  if (value) {
    return value;
  }
  return entry.value.kind;
}

function looksLikeEventId(name: string): boolean {
  return /^[a-zA-Z0-9_]+\.\d+$/.test(name);
}

function matchesCk3Path(uri: string): boolean {
  return /\.(txt|gui|info|asset|yml)$/i.test(uri);
}

function resolveSource(filePath: string): SourceKind {
  return config.referenceRoots.some((root) => filePath.startsWith(root)) ? "reference" : "mod";
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
