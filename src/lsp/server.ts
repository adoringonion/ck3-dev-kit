import {
  CancellationToken,
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
import { cancellationFromAbortSignal, RequestCancelledError, RequestContext } from "./requestContext";
import { ServerConfig, ServerSnapshot, ServerState, SourceKind } from "./serverState";

const connection = createConnection();
const documents = new TextDocuments(TextDocument);
const state = new ServerState();
let indexBuildPromise: Promise<void> | null = null;
let indexBuildController: AbortController | null = null;
const WORKSPACE_DIAGNOSTIC_IDLE_DELAY_MS = 15000;
const WORKSPACE_DIAGNOSTIC_BATCH_BUDGET_MS = 4;
const WORKSPACE_DIAGNOSTIC_BATCH_INTERVAL_MS = 250;
const activeDocumentWorkers = new Map<string, { version: number; worker: Worker }>();
const cancelledDocumentWorkers = new WeakSet<Worker>();
const documentAnalysisControllers = new Map<string, AbortController>();
let workspaceDiagnosticsController: AbortController | null = null;

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
    state.openDocument(document);
    if (!state.hasCurrentAnalysis(document)) {
      scheduleAnalysis(document, 50);
    }
  }
});

connection.onHover(({ textDocument, position }, token): Hover | null => timeRequest("hover", token, () => {
  const context = new RequestContext({ label: "hover", token });
  context.throwIfCancelled();
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }
  const snapshot = state.snapshot();
  context.throwIfCancelled();

  if (indexBuildPromise) {
    return indexingHover("CK3 Mod DevKit is building the symbol index. Hover, definition, and references will fill in when indexing completes.");
  }
  if (!snapshot.isIndexReady() && snapshot.getLastIndexError()) {
    return indexingHover(`CK3 Mod DevKit failed to build its symbol index.\n\n${snapshot.getLastIndexError()}`);
  }

  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }
  const cacheKey = state.hoverCacheKey(document, wordRange);
  const cached = snapshot.getHoverCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const parsed = currentParsedDocument(snapshot, document);
  const name = document.getText(wordRange);
  context.throwIfCancelled();
  const syntaxHelp = parsed
    ? getScriptSyntaxHelp(name, parsed.kind === "script" ? syntaxHelpContextAt(parsed, wordRange) : undefined)
    : getScriptSyntaxHelp(name);
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

  const definitions = snapshot.definitionSymbols(name, context);
  context.throwIfCancelled();
  const target = definitions[0];
  if (!target) {
    state.setHoverCache(cacheKey, null);
    return null;
  }

  const referenceCount = snapshot.referencesByName(name, context).length;
  context.throwIfCancelled();
  const hover = {
    contents: {
      kind: MarkupKind.Markdown,
      value: buildHoverMarkdown(
        target,
        referenceCount,
        definitions.length,
        snapshot.symbolSnippet(target),
        snapshot.localizationText(target),
        snapshot.localizationLanguage(target)
      ),
    },
    range: wordRange,
  };
  state.setHoverCache(cacheKey, hover);
  return hover;
}));

connection.onDefinition(({ textDocument, position }, token): Definition | null => timeRequest("definition", token, () => {
  const context = new RequestContext({ label: "definition", token });
  context.throwIfCancelled();
  const document = documents.get(textDocument.uri);
  const snapshot = state.snapshot();
  if (!document || indexBuildPromise || !snapshot.isIndexReady()) {
    return null;
  }
  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }

  const name = document.getText(wordRange);
  context.throwIfCancelled();
  const relevant = snapshot.definitionSymbols(name, context);
  if (relevant.length === 0) {
    return null;
  }
  return relevant.map(toLocation);
}));

connection.onReferences(({ textDocument, position }: ReferenceParams, token): Location[] | null => timeRequest("references", token, () => {
  const context = new RequestContext({ label: "references", token });
  context.throwIfCancelled();
  const document = documents.get(textDocument.uri);
  const snapshot = state.snapshot();
  if (!document || indexBuildPromise || !snapshot.isIndexReady()) {
    return null;
  }
  const wordRange = findWordRange(document, position);
  if (!wordRange) {
    return null;
  }
  const name = document.getText(wordRange);
  context.throwIfCancelled();
  return snapshot.referencesByName(name, context).map(toReferenceLocation);
}));

connection.onCompletion(({ textDocument, position }: CompletionParams, token): CompletionItem[] | null => timeRequest("completion", token, () => {
  const request = new RequestContext({ label: "completion", token });
  request.throwIfCancelled();
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }
  const snapshot = state.snapshot();

  const lines = document.getText().split(/\r?\n/);
  const currentLine = lines[position.line] ?? "";
  const linePrefix = currentLine.slice(0, position.character);
  const completionContext = inferCompletionContext(linePrefix, recentDocumentText(document, position));
  if (!completionContext) {
    return null;
  }

  request.throwIfCancelled();
  const symbols = snapshot.completionSymbols(completionContext.kinds, completionContext.query, 100, request);
  return symbols.map((symbol) => ({
    label: completionContext.prefix ? `${completionContext.prefix}${symbol.name}` : symbol.name,
    kind: toCompletionItemKind(symbol.kind),
    detail: `${symbol.kind} (${symbol.source})`,
    documentation: {
      kind: MarkupKind.Markdown,
      value: completionDocumentation(symbol),
    },
    textEdit: {
      range: findWordRange(document, position) ?? { start: position, end: position },
      newText: completionContext.prefix ? `${completionContext.prefix}${symbol.name}` : symbol.name,
    },
    sortText: `${symbol.source === "mod" ? "0" : "1"}-${symbol.name}`,
  }));
}));

connection.onDocumentSymbol(({ textDocument }) => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return [];
  }

  const snapshot = state.snapshot();
  const parsed = currentParsedDocument(snapshot, document);
  if (!parsed) {
    return [];
  }
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
  const context = new RequestContext({ label: "workspaceSymbol" });
  return state.snapshot().workspaceSymbols(query, context)
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
  const snapshot = state.snapshot();
  const context = new RequestContext({ label: "prepareRename" });
  const candidate = targetRenameCandidate(snapshot, document.uri, wordRange, name, context);
  const target = resolveModRenameTarget(candidate, snapshot.symbolsByName(name, context));
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
  const snapshot = state.snapshot();
  const context = new RequestContext({ label: "rename" });
  const candidate = targetRenameCandidate(snapshot, document.uri, wordRange, name, context);
  const target = resolveModRenameTarget(candidate, snapshot.symbolsByName(name, context));
  if (!target) {
    return null;
  }
  const symbols = filterModRenameSymbols(snapshot.symbolsByName(name, context), target);
  const references = filterModRenameReferences(snapshot.referencesByName(name, context), target);
  if (symbols.length === 0 && references.length === 0) {
    return null;
  }
  return buildRenameWorkspaceEdit(newName, symbols, references);
});

connection.onCodeAction((params, token): CodeAction[] => timeRequest("codeAction", token, () => {
  const context = new RequestContext({ label: "codeAction", token });
  context.throwIfCancelled();
  if (!params.context.diagnostics.some(isActionableDiagnostic)) {
    return [];
  }
  const actions: CodeAction[] = [];
  const document = documents.get(params.textDocument.uri);
  for (const diagnostic of params.context.diagnostics) {
    context.throwIfCancelled();
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
}));

connection.languages.inlayHint.on(({ textDocument }, token): InlayHint[] => timeRequest("inlayHint", token, () => {
  const context = new RequestContext({ label: "inlayHint", token });
  context.throwIfCancelled();
  const document = documents.get(textDocument.uri);
  if (!document) {
    return [];
  }
  const snapshot = state.snapshot();
  const cached = snapshot.inlayHintCache(document.uri, document.version);
  if (cached) {
    return cached;
  }
  const parsed = currentParsedDocument(snapshot, document);
  if (!parsed) {
    return [];
  }
  const hints = buildInlayHints(parsed, uriToFsPath(document.uri), snapshot.allSymbols(undefined, context));
  context.throwIfCancelled();
  state.setInlayHintCache(document.uri, document.version, hints);
  return hints;
}));

connection.languages.semanticTokens.on(({ textDocument }, token): SemanticTokens => timeRequest("semanticTokens", token, () => {
  const context = new RequestContext({ label: "semanticTokens", token });
  context.throwIfCancelled();
  const document = documents.get(textDocument.uri);
  if (!document) {
    return { data: [] };
  }
  const snapshot = state.snapshot();
  const cached = snapshot.semanticTokenCache(document.uri, document.version);
  if (cached) {
    return cached;
  }
  const parsed = currentParsedDocument(snapshot, document);
  if (!parsed) {
    return { data: [] };
  }
  const tokens = buildSemanticTokens(parsed);
  context.throwIfCancelled();
  state.setSemanticTokenCache(document.uri, document.version, tokens);
  return tokens;
}));

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
  state.openDocument(event.document);
  if (!state.hasCurrentAnalysis(event.document)) {
    scheduleAnalysis(event.document, 50);
  }
  scheduleDiagnostics(event.document, 2000);
  rescheduleWorkspaceDiagnostics();
});

documents.onDidChangeContent((event) => {
  state.markDocumentChanged(event.document);
  clearHoverCacheForUri(event.document.uri);
  scheduleAnalysis(event.document, 150);
  scheduleDiagnostics(event.document, 750);
  rescheduleWorkspaceDiagnostics();
});

documents.onDidClose((event) => {
  cancelDocumentWorker(event.document.uri);
  cancelDocumentAnalysisContext(event.document.uri);
  state.cancelDocumentAnalysis(event.document.uri);
  state.cancelDocumentDiagnostics(event.document.uri);
  clearHoverCacheForUri(event.document.uri);
  state.deleteLiveDocument(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  rescheduleWorkspaceDiagnostics();
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
    indexBuildController?.abort();
    try {
      await indexBuildPromise;
    } catch {
      // The previous build was intentionally cancelled by a newer request.
    }
  }

  indexBuildPromise = (async () => {
    const controller = new AbortController();
    indexBuildController = controller;
    const progress = await connection.window.createWorkDoneProgress();
    const context = new RequestContext({
      label: `rebuild index (${reason})`,
      token: cancellationFromAbortSignal(controller.signal),
      progress,
    });
    sendIndexStatus({ phase: "started", reason });
    progress.begin("CK3 Mod DevKit", undefined, `Building symbol index (${reason})`, false);
    state.markIndexRebuilding();
    cancelAllDocumentWorkers();
    cancelAllDocumentAnalysisContexts();
    cancelWorkspaceDiagnosticsContext();
    try {
      context.checkpoint("Collecting workspace files");
      context.report("Collecting workspace files");
      const nextIndex = await buildIndexInWorker(state.getConfig(), controller.signal);
      context.throwIfCancelled();
      context.checkpoint("Applying immutable workspace snapshot");
      state.setIndex(nextIndex);
      context.report("Syncing open documents");
      sendIndexStatus({ phase: "completed", reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.markIndexFailed(message);
      context.report("Index build failed");
      sendIndexStatus({ phase: "failed", reason, message });
      throw error;
    } finally {
      progress.done();
      if (indexBuildController === controller) {
        indexBuildController = null;
      }
      indexBuildPromise = null;
    }

    context.throwIfCancelled();
    for (const document of documents.all()) {
      state.openDocument(document);
      if (!state.hasCurrentAnalysis(document)) {
        scheduleAnalysis(document, 50);
      }
      scheduleDiagnostics(document, 750);
    }
    rescheduleWorkspaceDiagnostics();
  })();

  await indexBuildPromise;
}

function publishDiagnostics(document: TextDocument): void {
  const context = new RequestContext({ label: "publishDiagnostics" });
  const diagnostics = timeRequest<Diagnostic[]>("publishDiagnostics", undefined, () => state.collectDocumentDiagnostics(document, context));
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

function scheduleAnalysis(document: TextDocument, delayMs: number): void {
  cancelDocumentAnalysisContext(document.uri);
  const controller = new AbortController();
  documentAnalysisControllers.set(document.uri, controller);
  state.scheduleDocumentAnalysis(document.uri, delayMs, () => {
    const latestController = documentAnalysisControllers.get(document.uri);
    if (!latestController || latestController !== controller || controller.signal.aborted) {
      return;
    }
    const context = new RequestContext({
      label: `document analysis ${document.uri}`,
      token: cancellationFromAbortSignal(controller.signal),
    });
    void analyzeDocumentInWorker(document, context).catch((error) => {
      if (controller.signal.aborted) {
        return;
      }
      connection.console.error(`[analysis] ${document.uri}: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

function clearHoverCacheForUri(uri: string): void {
  state.clearHoverCacheForUri(uri);
}

async function scheduleWorkspaceDiagnostics(): Promise<void> {
  cancelWorkspaceDiagnosticsContext();
  const controller = new AbortController();
  workspaceDiagnosticsController = controller;
  const progress = await connection.window.createWorkDoneProgress();
  const context = new RequestContext({
    label: "workspace diagnostics",
    token: cancellationFromAbortSignal(controller.signal),
    progress,
  });
  progress.begin("CK3 Mod DevKit", undefined, "Running workspace diagnostics", true);
  const entries = Array.from(state.getIndex().documents.entries())
    .filter(([filePath]) => state.resolveSource(filePath) === "mod")
    .map(([filePath, parsed]) => ({ filePath, parsed }));
  state.scheduleWorkspaceDiagnostics(entries, ({ filePath, parsed }) => {
      if (context.token?.isCancellationRequested) {
        return;
      }
      const uri = pathToFileURL(filePath).toString();
      if (documents.get(uri)) {
        return;
      }

      const diagnostics = state.collectIndexedDiagnostics(filePath, parsed, context);
      connection.sendDiagnostics({
        uri,
        diagnostics,
      });
    }, {
      initialDelayMs: WORKSPACE_DIAGNOSTIC_IDLE_DELAY_MS,
      batchBudgetMs: WORKSPACE_DIAGNOSTIC_BATCH_BUDGET_MS,
      batchIntervalMs: WORKSPACE_DIAGNOSTIC_BATCH_INTERVAL_MS,
      isCancelled: () => context.token?.isCancellationRequested ?? false,
      onProgress: (processed, total) => {
        if (context.token?.isCancellationRequested) {
          return;
        }
        if (processed >= total) {
          progress.done();
          if (workspaceDiagnosticsController === controller) {
            workspaceDiagnosticsController = null;
          }
          return;
        }
        const percentage = total > 0 ? Math.round((processed / total) * 100) : 100;
        context.report(`Workspace diagnostics ${processed}/${total}`);
        progress.report(percentage, `Workspace diagnostics ${processed}/${total}`);
      },
    });
}

function rescheduleWorkspaceDiagnostics(): void {
  state.cancelWorkspaceDiagnostics();
  void scheduleWorkspaceDiagnostics();
}

function targetRenameCandidate(
  snapshot: ServerSnapshot,
  documentUri: string,
  range: Range,
  name: string,
  context?: RequestContext,
): { kind: string; source: SourceKind } | null {
  const candidate = snapshot.renameCandidate(documentUri, range.start, name, context);
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

function currentParsedDocument(snapshot: ServerSnapshot, document: TextDocument): ParsedDocument | undefined {
  if (!state.hasCurrentAnalysis(document)) {
    return undefined;
  }
  return snapshot.parsedDocumentForUri(document.uri);
}

function isActionableDiagnostic(diagnostic: Diagnostic): boolean {
  return diagnostic.message === "Localization files should be saved as UTF-8 with BOM."
    || /^Unresolved localization reference: /.test(diagnostic.message)
    || /^Unresolved event reference: /.test(diagnostic.message)
    || /^Unresolved (scripted_effect|scripted_trigger|script_value) reference: /.test(diagnostic.message);
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

function sendIndexStatus(payload: IndexStatusPayload): void {
  connection.sendNotification(INDEX_STATUS_NOTIFICATION, payload);
}

function timeRequest<T>(label: string, token: CancellationToken | undefined, fn: () => T): T {
  const started = Date.now();
  try {
    if (token?.isCancellationRequested) {
      throw new RequestCancelledError(`${label} cancelled.`);
    }
    return fn();
  } catch (error) {
    if (error instanceof RequestCancelledError) {
      return null as T;
    }
    throw error;
  } finally {
    const elapsed = Date.now() - started;
    if (elapsed >= 50) {
      connection.console.info(`[timing] ${label} ${elapsed}ms`);
    }
  }
}

async function buildIndexInWorker(currentConfig: ServerConfig, signal?: AbortSignal): Promise<WorkspaceIndex> {
  const workerPath = path.join(__dirname, "indexWorker.js");
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: currentConfig,
    });
    const abort = () => {
      worker.terminate().catch(() => undefined);
      reject(new RequestCancelledError("index build cancelled."));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });

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
      signal?.removeEventListener("abort", abort);
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
      signal?.removeEventListener("abort", abort);
      worker.terminate().catch(() => undefined);
      reject(error);
    });

    worker.once("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        return;
      }
      if (code !== 0) {
        reject(new Error(`Index worker exited with code ${code}.`));
      }
    });
  });
}

async function analyzeDocumentInWorker(document: TextDocument, context: RequestContext): Promise<void> {
  context.throwIfCancelled();
  const current = documents.get(document.uri);
  if (!current) {
    return;
  }
  const version = current.version;
  const filePath = uriToFsPath(current.uri);
  const source = state.resolveSource(filePath);
  const previous = state.getAnalysisBaseParsed(document.uri, filePath);
  const workerPath = path.join(__dirname, "documentWorker.js");
  context.report(`Analyzing ${path.basename(filePath)}`);

  const result = await new Promise<{
    parsed: ParsedDocument;
    symbols: SymbolRecord[];
    references: ReferenceRecord[];
  }>((resolve, reject) => {
    let unsubscribeCancellation: (() => void) | { dispose(): void } | undefined;
    const abort = () => {
      if (typeof unsubscribeCancellation === "function") {
        unsubscribeCancellation();
      } else {
        unsubscribeCancellation?.dispose();
      }
      cancelDocumentWorker(document.uri);
      reject(new RequestCancelledError(`document analysis cancelled: ${document.uri}`));
    };
    if (context.token?.isCancellationRequested) {
      abort();
      return;
    }
    cancelStaleDocumentWorker(document.uri, version);
    const worker = new Worker(workerPath, {
      workerData: {
        filePath,
        text: current.getText(),
        source,
        previous,
      },
    });
    activeDocumentWorkers.set(document.uri, { version, worker });
    unsubscribeCancellation = context.token?.onCancellationRequested?.(abort);

    worker.once("message", (message: {
      ok: boolean;
      record?: {
        parsed: ParsedDocument;
        symbols: SymbolRecord[];
        references: ReferenceRecord[];
      };
      error?: string;
    }) => {
      if (typeof unsubscribeCancellation === "function") {
        unsubscribeCancellation();
      } else {
        unsubscribeCancellation?.dispose();
      }
      clearDocumentWorker(document.uri, version, worker);
      worker.terminate().catch(() => undefined);
      if (!message.ok || !message.record) {
        reject(new Error(message.error ?? "Unknown document worker failure."));
        return;
      }
      resolve(message.record);
    });

    worker.once("error", (error) => {
      if (typeof unsubscribeCancellation === "function") {
        unsubscribeCancellation();
      } else {
        unsubscribeCancellation?.dispose();
      }
      clearDocumentWorker(document.uri, version, worker);
      if (cancelledDocumentWorkers.has(worker)) {
        return;
      }
      worker.terminate().catch(() => undefined);
      reject(error);
    });

    worker.once("exit", (code) => {
      if (typeof unsubscribeCancellation === "function") {
        unsubscribeCancellation();
      } else {
        unsubscribeCancellation?.dispose();
      }
      clearDocumentWorker(document.uri, version, worker);
      if (cancelledDocumentWorkers.has(worker)) {
        return;
      }
      if (code !== 0) {
        reject(new Error(`Document worker exited with code ${code}.`));
      }
    });
  });

  const latest = documents.get(document.uri);
  if (!latest || latest.version !== version) {
    return;
  }

  context.throwIfCancelled();
  context.checkpoint(`Applying analysis for ${path.basename(filePath)}`);
  state.applyAnalyzedDocument(document.uri, version, source, result.parsed, result.symbols, result.references);
  scheduleDiagnostics(latest, 50);
}

function cancelStaleDocumentWorker(uri: string, nextVersion: number): void {
  const active = activeDocumentWorkers.get(uri);
  if (!active) {
    return;
  }
  if (active.version >= nextVersion) {
    return;
  }
  activeDocumentWorkers.delete(uri);
  cancelledDocumentWorkers.add(active.worker);
  active.worker.terminate().catch(() => undefined);
}

function cancelDocumentWorker(uri: string): void {
  const active = activeDocumentWorkers.get(uri);
  if (!active) {
    return;
  }
  activeDocumentWorkers.delete(uri);
  cancelledDocumentWorkers.add(active.worker);
  active.worker.terminate().catch(() => undefined);
}

function cancelAllDocumentWorkers(): void {
  for (const [uri, active] of activeDocumentWorkers.entries()) {
    activeDocumentWorkers.delete(uri);
    cancelledDocumentWorkers.add(active.worker);
    active.worker.terminate().catch(() => undefined);
  }
}

function cancelDocumentAnalysisContext(uri: string): void {
  const controller = documentAnalysisControllers.get(uri);
  if (!controller) {
    return;
  }
  documentAnalysisControllers.delete(uri);
  controller.abort();
}

function cancelAllDocumentAnalysisContexts(): void {
  for (const [uri, controller] of documentAnalysisControllers.entries()) {
    documentAnalysisControllers.delete(uri);
    controller.abort();
  }
}

function cancelWorkspaceDiagnosticsContext(): void {
  if (!workspaceDiagnosticsController) {
    return;
  }
  workspaceDiagnosticsController.abort();
  workspaceDiagnosticsController = null;
}

function clearDocumentWorker(uri: string, version: number, worker: Worker): void {
  const active = activeDocumentWorkers.get(uri);
  if (!active) {
    return;
  }
  if (active.version === version && active.worker === worker) {
    activeDocumentWorkers.delete(uri);
  }
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
