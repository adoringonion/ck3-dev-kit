import {
  CodeAction,
  CompletionItem,
  CompletionParams,
  createConnection,
  Definition,
  Diagnostic,
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
  WorkspaceSymbolParams,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as path from "path";
import { pathToFileURL } from "url";
import { Worker } from "worker_threads";
import { WorkspaceIndex } from "../core/indexer";
import { analyzeErrorLogFile } from "../core/errorLog";
import { parseDocumentText } from "../core/document";
import { ParsedDocument, AssignmentNode, ReferenceRecord, SymbolRecord } from "../core/types";
import { getScriptSyntaxHelp, SyntaxHelpContext } from "../extension/dynamicReferenceHelp";
import { inferCompletionContext } from "../extension/completion";
import {
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
import {
  ANALYZE_ERROR_LOG_REQUEST,
  AnalyzeErrorLogParams,
  AnalyzeErrorLogResponse,
  INDEX_STATUS_NOTIFICATION,
  IndexStatusPayload,
  REBUILD_INDEX_NOTIFICATION,
} from "./protocol";
import { ServerConfig, ServerState, SourceKind } from "./serverState";

const connection = createConnection();
const documents = new TextDocuments(TextDocument);
const state = new ServerState();
let indexBuildPromise: Promise<void> | null = null;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  state.setConfig(normalizeConfig(params.initializationOptions));
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      codeActionProvider: true,
      completionProvider: {
        triggerCharacters: [".", ":", "="],
      },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
      inlayHintProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...SEMANTIC_TOKEN_TYPES],
          tokenModifiers: [],
        },
        full: true,
      },
    },
  };
});

connection.onInitialized(() => {
  void rebuildIndex("startup");
  for (const document of documents.all()) {
    state.syncDocument(document);
  }
});

connection.onHover(({ textDocument, position }): Hover | null => timeRequest("hover", () => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }

  if (indexBuildPromise) {
    return indexingHover("CK3 Mod DevKit is building the symbol index. Hover, definition, and references will fill in when indexing completes.");
  }
  if (!state.isIndexReady() && state.getLastIndexError()) {
    return indexingHover(`CK3 Mod DevKit failed to build its symbol index.\n\n${state.getLastIndexError()}`);
  }

  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }
  const cacheKey = state.hoverCacheKey(document, wordRange);
  const cached = state.getHoverCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const parsed = parsedDocumentForUri(document.uri)
    ?? parseDocumentText(uriToFsPath(document.uri), document.getText());
  const name = document.getText(wordRange);
  const syntaxHelp = getScriptSyntaxHelp(name, parsed.kind === "script" ? syntaxHelpContextAt(parsed, wordRange) : undefined);
  if (syntaxHelp) {
    const hover = {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${syntaxHelp.id}**\n\n${syntaxHelp.title}\n\n${syntaxHelp.summary}\n\n${syntaxHelp.details.join("\n\n")}`,
      },
      range: wordRange,
    };
    state.setHoverCache(cacheKey, hover);
    return hover;
  }

  const definitions = symbolsByName(name)
    .filter((item) => item.kind !== "localization-reference")
    .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod"));
  const target = definitions[0];
  if (!target) {
    state.setHoverCache(cacheKey, null);
    return null;
  }

  const referenceCount = referencesByName(name).length;
  const hover = {
    contents: {
      kind: MarkupKind.Markdown,
      value: buildHoverMarkdown(
        target,
        referenceCount,
        definitions.length,
        state.symbolSnippet(target),
        state.localizationText(target),
        state.localizationLanguage(target)
      ),
    },
    range: wordRange,
  };
  state.setHoverCache(cacheKey, hover);
  return hover;
}));

connection.onDefinition(({ textDocument, position }): Definition | null => timeRequest("definition", () => {
  const document = documents.get(textDocument.uri);
  if (!document || indexBuildPromise || !state.isIndexReady()) {
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
}));

connection.onReferences(({ textDocument, position }: ReferenceParams): Location[] | null => timeRequest("references", () => {
  const document = documents.get(textDocument.uri);
  if (!document || indexBuildPromise || !state.isIndexReady()) {
    return null;
  }
  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }
  const name = document.getText(wordRange);
  return referencesByName(name).map(toReferenceLocation);
}));

connection.onCompletion(({ textDocument, position }: CompletionParams): CompletionItem[] | null => timeRequest("completion", () => {
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
}));

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
        state.preferredLocalizationFile()
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
        state.preferredEventFile(unresolvedEvent[1])
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
        state.preferredScriptDefinitionFile(unresolvedScriptDefinition[1] as "scripted_effect" | "scripted_trigger" | "script_value")
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

connection.onNotification(REBUILD_INDEX_NOTIFICATION, () => {
  void rebuildIndex("manual command");
});

connection.onRequest(ANALYZE_ERROR_LOG_REQUEST, (params: AnalyzeErrorLogParams | undefined): AnalyzeErrorLogResponse => {
  const config = state.getConfig();
  return analyzeErrorLogFile({
    logPath: params?.logPath ?? config.errorLogPath ?? "",
    modRoots: config.modRoots,
    referenceRoots: config.referenceRoots,
    index: state.getIndex(),
  });
});

documents.onDidOpen((event) => {
  state.syncDocument(event.document);
  scheduleDiagnostics(event.document, 2000);
});

documents.onDidChangeContent((event) => {
  state.syncDocument(event.document);
  clearHoverCacheForUri(event.document.uri);
  scheduleDiagnostics(event.document, 750);
});

documents.onDidClose((event) => {
  state.cancelDocumentDiagnostics(event.document.uri);
  clearHoverCacheForUri(event.document.uri);
  state.deleteLiveDocument(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();

function normalizeConfig(value: unknown): ServerConfig {
  const current = state.getConfig();
  if (!value || typeof value !== "object") {
    return current;
  }
  const candidate = value as Partial<ServerConfig>;
  return {
    modRoots: Array.isArray(candidate.modRoots) ? candidate.modRoots : [],
    referenceRoots: Array.isArray(candidate.referenceRoots) ? candidate.referenceRoots : [],
    maxFiles: typeof candidate.maxFiles === "number" ? candidate.maxFiles : 20000,
    errorLogPath: typeof candidate.errorLogPath === "string" ? candidate.errorLogPath : current.errorLogPath,
  };
}

async function rebuildIndex(reason: string): Promise<void> {
  if (indexBuildPromise) {
    sendIndexStatus({ phase: "busy", reason });
    await indexBuildPromise;
    return;
  }

  indexBuildPromise = (async () => {
    sendIndexStatus({ phase: "started", reason });
    state.markIndexRebuilding();
    try {
      const nextIndex = await buildIndexInWorker(state.getConfig());
      state.setIndex(nextIndex);
      sendIndexStatus({ phase: "completed", reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.markIndexFailed(message);
      sendIndexStatus({ phase: "failed", reason, message });
      throw error;
    } finally {
      indexBuildPromise = null;
    }

    for (const document of documents.all()) {
      state.syncDocument(document);
      scheduleDiagnostics(document, 750);
    }
    scheduleWorkspaceDiagnostics();
  })();

  await indexBuildPromise;
}

function publishDiagnostics(document: TextDocument): void {
  const diagnostics = timeRequest("publishDiagnostics", () => state.collectDocumentDiagnostics(document));
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics,
  });
}

function scheduleDiagnostics(document: TextDocument, delayMs: number): void {
  state.scheduleDocumentDiagnostics(document.uri, delayMs, () => {
    publishDiagnostics(document);
  });
}

function clearHoverCacheForUri(uri: string): void {
  state.clearHoverCacheForUri(uri);
}

function scheduleWorkspaceDiagnostics(): void {
  const entries = Array.from(state.getIndex().documents.entries())
    .filter(([filePath]) => state.resolveSource(filePath) === "mod")
    .map(([filePath, parsed]) => ({ filePath, parsed }));
  state.scheduleWorkspaceDiagnostics(entries, ({ filePath, parsed }) => {
      const uri = pathToFileURL(filePath).toString();
      if (documents.get(uri)) {
        return;
      }

      const diagnostics = state.collectIndexedDiagnostics(filePath, parsed);
      connection.sendDiagnostics({
        uri,
        diagnostics,
      });
    });
}

function symbolsByName(name: string): SymbolRecord[] {
  return state.symbolsByName(name);
}

function referencesByName(name: string): ReferenceRecord[] {
  return state.referencesByName(name);
}

function allSymbols(query?: string): SymbolRecord[] {
  return state.allSymbols(query);
}

function completionSymbols(kinds: string[], query = "", limit = 100): SymbolRecord[] {
  return state.completionSymbols(kinds, query, limit);
}

function targetRenameCandidate(documentUri: string, range: Range, name: string): { kind: string; source: SourceKind } | null {
  const candidate = state.renameCandidate(documentUri, range.start, name);
  if (!candidate) {
    return null;
  }
  return {
    kind: normalizeRenameKind(candidate.kind),
    source: candidate.source,
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

function indexingHover(message: string): Hover {
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: message,
    },
  };
}

function parsedDocumentForUri(uri: string): ParsedDocument | undefined {
  return state.getParsedDocumentForUri(uri);
}

function sendIndexStatus(payload: IndexStatusPayload): void {
  connection.sendNotification(INDEX_STATUS_NOTIFICATION, payload);
}

function timeRequest<T>(label: string, fn: () => T): T {
  const started = Date.now();
  try {
    return fn();
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed >= 50) {
      connection.console.info(`[timing] ${label} ${elapsed}ms`);
    }
  }
}

async function buildIndexInWorker(currentConfig: ServerConfig): Promise<WorkspaceIndex> {
  const workerPath = path.join(__dirname, "indexWorker.js");
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: currentConfig,
    });

    worker.once("message", (message: {
      ok: boolean;
      index?: {
        symbols: Array<[string, SymbolRecord[]]>;
        references: Array<[string, ReferenceRecord[]]>;
        documents: Array<[string, ParsedDocument]>;
        files: string[];
      };
      error?: string;
    }) => {
      worker.terminate().catch(() => undefined);
      if (!message.ok || !message.index) {
        reject(new Error(message.error ?? "Unknown index worker failure."));
        return;
      }
      resolve({
        symbols: new Map(message.index.symbols),
        references: new Map(message.index.references),
        documents: new Map(message.index.documents),
        files: message.index.files,
      });
    });

    worker.once("error", (error) => {
      worker.terminate().catch(() => undefined);
      reject(error);
    });

    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Index worker exited with code ${code}.`));
      }
    });
  });
}

function symbolMatchesCompletionKinds(symbolKind: string, completionKinds: string[]): boolean {
  return completionKinds.some((kind) => {
    if (kind === "character_modifier" || kind === "county_modifier" || kind === "province_modifier" || kind === "artifact_modifier") {
      return symbolKind === "modifier";
    }
    return symbolKind === kind;
  });
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
