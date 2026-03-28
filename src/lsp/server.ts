import {
  CodeAction,
  CompletionItem,
  CompletionParams,
  createConnection,
  Definition,
  Diagnostic,
  DiagnosticSeverity,
  DocumentDiagnosticReport,
  DocumentDiagnosticReportKind,
  FullDocumentDiagnosticReport,
  Hover,
  InitializeParams,
  InitializeResult,
  InlayHint,
  Location,
  MarkupKind,
  Position,
  PrepareRenameParams,
  Range,
  ReferenceParams,
  RenameParams,
  SemanticTokens,
  SymbolInformation,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceDiagnosticReport,
  WorkspaceSymbolParams,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as path from "path";
import { pathToFileURL } from "url";
import { createDocumentIndexRecord, WorkspaceIndex } from "../core/indexer";
import { validateParsedDocumentAgainstIndex, validateReferences } from "../core/references";
import { parseDocumentText } from "../core/document";
import { LocalizationDocument, ParsedDocument, AssignmentNode, ReferenceRecord, SymbolRecord } from "../core/types";
import { buildCachedWorkspaceIndex } from "../cli-shared";
import { getScriptSyntaxHelp, SyntaxHelpContext } from "../extension/dynamicReferenceHelp";
import { inferCompletionContext } from "../extension/completion";
import {
  buildDocumentDiagnosticReport,
  buildHoverMarkdown,
  buildInlayHints,
  buildRenameWorkspaceEdit,
  buildSemanticTokens,
  createAddUtf8BomCodeAction,
  createConvertGuiTextToRawTextCodeAction,
  createMissingEventCodeAction,
  createMissingScriptDefinitionCodeAction,
  completionDocumentation,
  createMissingLocalizationCodeAction,
  describeEntry,
  SEMANTIC_TOKEN_TYPES,
  toCompletionItemKind,
  toLspRange,
  toSymbolKind,
  toWorkspaceSymbol,
} from "./features";
import {
  filterModRenameReferences,
  filterModRenameSymbols,
  normalizeRenameKind,
  resolveModRenameTarget,
} from "./rename";

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
      renameProvider: {
        prepareProvider: true,
      },
      codeActionProvider: true,
      inlayHintProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...SEMANTIC_TOKEN_TYPES],
          tokenModifiers: [],
        },
        full: true,
      },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: true,
      },
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

  const definitions = symbolsByName(name)
    .filter((item) => item.kind !== "localization-reference")
    .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod"));
  const target = definitions[0];
  if (!target) {
    return null;
  }

  const referenceCount = referencesByName(name).length;
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: buildHoverMarkdown(
        target,
        referenceCount,
        definitions.length,
        symbolSnippet(target),
        localizationText(target),
        localizationLanguage(target)
      ),
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
    kind: toCompletionItemKind(symbol.kind),
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
        ? toSymbolKind("namespace")
        : looksLikeEventId(entry.key)
          ? toSymbolKind("event")
          : toSymbolKind("definition"),
      range: toLspRange(entry.range),
      selectionRange: toLspRange(entry.keyRange),
    }));
});

connection.onWorkspaceSymbol(({ query }: WorkspaceSymbolParams): SymbolInformation[] => {
  return allSymbols(query)
    .filter((symbol) => symbol.kind !== "localization-reference")
    .map((symbol) => toWorkspaceSymbol(symbol) as SymbolInformation);
});

connection.onPrepareRename(({ textDocument, position }: PrepareRenameParams) => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }
  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }
  const name = document.getText(wordRange);
  const candidate = targetRenameCandidate(document.uri, wordRange, name);
  const target = resolveModRenameTarget(candidate, symbolsByName(name));
  if (!target) {
    return null;
  }
  return {
    range: wordRange,
    placeholder: name,
  };
});

connection.onRenameRequest(({ textDocument, position, newName }: RenameParams): WorkspaceEdit | null => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }
  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }
  const name = document.getText(wordRange);
  const candidate = targetRenameCandidate(document.uri, wordRange, name);
  const target = resolveModRenameTarget(candidate, symbolsByName(name));
  if (!target) {
    return null;
  }
  const symbols = filterModRenameSymbols(symbolsByName(name), target);
  const references = filterModRenameReferences(referencesByName(name), target);
  if (symbols.length === 0 && references.length === 0) {
    return null;
  }
  return buildRenameWorkspaceEdit(newName, symbols, references);
});

connection.onCodeAction((params): CodeAction[] => {
  const actions: CodeAction[] = [];
  const document = documents.get(params.textDocument.uri);
  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.message === "Localization files should be saved as UTF-8 with BOM.") {
      actions.push(createAddUtf8BomCodeAction(diagnostic, params.textDocument.uri));
      continue;
    }
    const unresolvedLocalization = diagnostic.message.match(/^Unresolved localization reference: ([\w.:-]+)$/);
    if (unresolvedLocalization) {
      const action = createMissingLocalizationCodeAction(
        diagnostic,
        unresolvedLocalization[1],
        preferredLocalizationFile()
      );
      if (action) {
        actions.push(action);
      }

      const rawTextAction = document
        ? createGuiRawTextQuickFix(document, diagnostic, unresolvedLocalization[1])
        : null;
      if (rawTextAction) {
        actions.push(rawTextAction);
      }
      continue;
    }

    const unresolvedEvent = diagnostic.message.match(/^Unresolved event reference: ([\w.:-]+)$/);
    if (unresolvedEvent) {
      const action = createMissingEventCodeAction(
        diagnostic,
        unresolvedEvent[1],
        preferredEventFile(unresolvedEvent[1])
      );
      if (action) {
        actions.push(action);
      }
      continue;
    }

    {
      const unresolvedScriptDefinition = diagnostic.message.match(/^Unresolved (scripted_effect|scripted_trigger|script_value) reference: ([\w.:-]+)$/);
      if (!unresolvedScriptDefinition) {
        continue;
      }
      const action = createMissingScriptDefinitionCodeAction(
        diagnostic,
        unresolvedScriptDefinition[2],
        unresolvedScriptDefinition[1] as "scripted_effect" | "scripted_trigger" | "script_value",
        preferredScriptDefinitionFile(unresolvedScriptDefinition[1] as "scripted_effect" | "scripted_trigger" | "script_value")
      );
      if (action) {
        actions.push(action);
      }
      continue;
    }
  }
  return actions;
});

connection.languages.inlayHint.on(({ textDocument }): InlayHint[] => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return [];
  }
  const parsed = parseDocumentText(uriToFsPath(document.uri), document.getText());
  return buildInlayHints(parsed, uriToFsPath(document.uri), allSymbols());
});

connection.languages.semanticTokens.on(({ textDocument }): SemanticTokens => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return { data: [] };
  }
  const parsed = parseDocumentText(uriToFsPath(document.uri), document.getText());
  return buildSemanticTokens(parsed);
});

connection.languages.diagnostics.on((params): DocumentDiagnosticReport => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return {
      kind: DocumentDiagnosticReportKind.Full,
      items: [],
    };
  }
  return buildDocumentDiagnosticReport(collectDocumentDiagnostics(document));
});

connection.languages.diagnostics.onWorkspace((): WorkspaceDiagnosticReport => {
  const items = Array.from(index.documents.entries())
    .map(([filePath, parsed]) => {
      const diagnostics = collectValidationDiagnostics(parsed, filePath);
      return {
        kind: DocumentDiagnosticReportKind.Full,
        uri: pathToFileURL(filePath).toString(),
        version: null,
        items: diagnostics,
      } as FullDocumentDiagnosticReport & { uri: string; version: null };
    })
    .filter((entry) => entry.items.length > 0);
  return { items };
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
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: collectDocumentDiagnostics(document),
  });
}

function collectDocumentDiagnostics(document: TextDocument): Diagnostic[] {
  const filePath = uriToFsPath(document.uri);
  const live = liveDocuments.get(document.uri) ?? {
    ...createDocumentIndexRecord(filePath, document.getText(), resolveSource(filePath)),
    source: resolveSource(filePath),
  };
  return collectValidationDiagnostics(live.parsed, filePath);
}

function collectValidationDiagnostics(parsed: ParsedDocument, filePath: string): Diagnostic[] {
  const liveSymbols = createDocumentIndexRecord(filePath, parsed.text, resolveSource(filePath)).symbols;
  const overlayedSymbols = overlaySymbols(pathToFileURL(filePath).toString(), liveSymbols);
  const validation = validateParsedDocumentAgainstIndex(parsed, {
    ...index,
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

  if (parsed.kind === "localization" && resolveSource(filePath) === "mod" && !parsed.text.startsWith("\uFEFF")) {
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

function targetRenameCandidate(documentUri: string, range: Range, name: string): { kind: string; source: SourceKind } | null {
  const filePath = uriToFsPath(documentUri);
  const live = liveDocuments.get(documentUri);
  const symbols = (live?.symbols ?? []).filter((symbol) =>
    symbol.name === name &&
    symbol.range.start.line === range.start.line &&
    symbol.range.start.character === range.start.character
  );
  if (symbols.length > 0) {
    return {
      kind: normalizeRenameKind(symbols[0].kind),
      source: symbols[0].source,
    };
  }

  const baseSymbols = (index.symbols.get(name) ?? []).filter((symbol) =>
    symbol.path === filePath &&
    symbol.range.start.line === range.start.line &&
    symbol.range.start.character === range.start.character
  );
  if (baseSymbols.length > 0) {
    return {
      kind: normalizeRenameKind(baseSymbols[0].kind),
      source: baseSymbols[0].source,
    };
  }

  const references = (live?.references ?? []).filter((reference) =>
    reference.name === name &&
    reference.range.start.line === range.start.line &&
    reference.range.start.character === range.start.character
  );
  if (references.length > 0) {
    return {
      kind: normalizeRenameKind(references[0].kind),
      source: references[0].source,
    };
  }

  const baseReferences = (index.references.get(name) ?? []).filter((reference) =>
    reference.path === filePath &&
    reference.range.start.line === range.start.line &&
    reference.range.start.character === range.start.character
  );
  if (baseReferences.length > 0) {
    return {
      kind: normalizeRenameKind(baseReferences[0].kind),
      source: baseReferences[0].source,
    };
  }

  return null;
}

function preferredLocalizationFile(): string | null {
  for (const root of config.modRoots) {
    const folder = path.join(root, "localization");
    if (!fsExists(folder)) {
      continue;
    }
    const files = walkFiles(folder).filter((file) => file.toLowerCase().endsWith(".yml"));
    if (files.length > 0) {
      return files.sort()[0];
    }
  }
  return null;
}

function preferredScriptDefinitionFile(kind: "scripted_effect" | "scripted_trigger" | "script_value"): string | null {
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

  for (const root of config.modRoots) {
    const folder = path.join(root, relativeFolder);
    if (!fsExists(folder)) {
      const parent = path.dirname(folder);
      if (!fsExists(parent)) {
        continue;
      }
      return path.join(folder, fallbackName);
    }
    const files = walkFiles(folder).filter((file) => file.toLowerCase().endsWith(".txt"));
    if (files.length > 0) {
      return files.sort()[0];
    }
    return path.join(folder, fallbackName);
  }
  return null;
}

function preferredEventFile(eventId: string): string | null {
  const namespace = eventId.includes(".") ? eventId.split(".")[0] : "generated";
  for (const root of config.modRoots) {
    const folder = path.join(root, "events");
    if (!fsExists(folder)) {
      const parent = path.dirname(folder);
      if (!fsExists(parent)) {
        continue;
      }
      return path.join(folder, `${namespace}_events.txt`);
    }
    const files = walkFiles(folder).filter((file) => file.toLowerCase().endsWith(".txt"));
    const namespaceMatch = files.find((file) => path.basename(file).toLowerCase().includes(namespace.toLowerCase()));
    if (namespaceMatch) {
      return namespaceMatch;
    }
    return path.join(folder, `${namespace}_events.txt`);
  }
  return null;
}

function walkFiles(root: string): string[] {
  const results: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const stat = safeStat(current);
    if (!stat) {
      continue;
    }
    if (stat.isDirectory()) {
      for (const child of safeReadDir(current)) {
        queue.push(path.join(current, child));
      }
      continue;
    }
    results.push(current);
  }
  return results;
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

function recentDocumentText(document: TextDocument, position: Position): string {
  const startLine = Math.max(position.line - 6, 0);
  const start = document.offsetAt({ line: startLine, character: 0 });
  const end = document.offsetAt(position);
  return document.getText().slice(start, end);
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

function symbolSnippet(symbol: SymbolRecord): string | undefined {
  const text = liveDocuments.get(pathToFileURL(symbol.path).toString())?.parsed.text
    ?? index.documents.get(symbol.path)?.text;
  if (!text) {
    return undefined;
  }

  const lines = text.split(/\r?\n/);
  const startLine = Math.max(symbol.range.start.line - 1, 0);
  const endLine = Math.min(symbol.range.end.line + 1, lines.length - 1);
  return lines.slice(startLine, endLine + 1).join("\n").trim();
}

function localizationText(symbol: SymbolRecord): string | undefined {
  if (symbol.kind !== "localization") {
    return undefined;
  }
  const parsed = parsedDocumentForSymbol(symbol);
  if (!parsed || parsed.kind !== "localization") {
    return undefined;
  }
  return parsed.entries.find((entry) => entry.key === symbol.name)?.value;
}

function localizationLanguage(symbol: SymbolRecord): string | null | undefined {
  if (symbol.kind !== "localization") {
    return undefined;
  }
  const parsed = parsedDocumentForSymbol(symbol);
  if (!parsed || parsed.kind !== "localization") {
    return undefined;
  }
  return parsed.language;
}

function parsedDocumentForSymbol(symbol: SymbolRecord): ParsedDocument | undefined {
  const live = liveDocuments.get(pathToFileURL(symbol.path).toString())?.parsed;
  if (live) {
    return live;
  }
  return index.documents.get(symbol.path);
}

function symbolMatchesCompletionKinds(symbolKind: string, completionKinds: string[]): boolean {
  return completionKinds.some((kind) => {
    if (kind === "character_modifier" || kind === "county_modifier" || kind === "province_modifier" || kind === "artifact_modifier") {
      return symbolKind === "modifier";
    }
    return symbolKind === kind;
  });
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

function looksLikeEventId(name: string): boolean {
  return /^[a-zA-Z0-9_]+\.\d+$/.test(name);
}

function fsExists(filePath: string): boolean {
  try {
    return require("fs").existsSync(filePath);
  } catch {
    return false;
  }
}

function safeStat(filePath: string) {
  try {
    return require("fs").statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadDir(filePath: string): string[] {
  try {
    return require("fs").readdirSync(filePath);
  } catch {
    return [];
  }
}

function createGuiRawTextQuickFix(document: TextDocument, diagnostic: Diagnostic, symbolName: string): CodeAction | null {
  const line = document.getText({
    start: { line: diagnostic.range.start.line, character: 0 },
    end: { line: diagnostic.range.start.line + 1, character: 0 },
  }).replace(/\r?\n$/, "");
  const match = line.match(/^(\s*)text(\s*=\s*)([\w.:-]+)\s*$/);
  if (!match || match[3] !== symbolName) {
    return null;
  }
  const keyStart = match[1].length;
  const keyEnd = keyStart + "text".length;
  const valueStart = keyEnd + match[2].length;
  const valueEnd = valueStart + symbolName.length;
  return createConvertGuiTextToRawTextCodeAction(
    diagnostic,
    document.uri,
    symbolName,
    diagnostic.range.start.line,
    keyStart,
    keyEnd,
    valueStart,
    valueEnd
  );
}
