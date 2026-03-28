import * as vscode from "vscode";
import { parseLocalization } from "../core/localization";
import { parseScript, scalarValue } from "../core/parser";
import { AssignmentNode, ParsedDocument, Range, ReferenceRecord, SymbolRecord } from "../core/types";
import { inferCompletionContext } from "./completion";
import { getScriptSyntaxHelp, SyntaxHelpContext } from "./dynamicReferenceHelp";
import { IndexStore } from "./indexStore";
import { readConfig } from "./config";
import { resolveConfiguredSource } from "./sourceResolution";

const SELECTOR: vscode.DocumentSelector = [
  { scheme: "file", pattern: "**/*.{txt,gui,info,asset,yml}" },
];

interface ProviderOptions {
  hover?: boolean;
  diagnostics?: boolean;
}

export function registerProviders(context: vscode.ExtensionContext, store: IndexStore, options: ProviderOptions = {}): void {
  const enableHover = options.hover ?? true;
  const enableDiagnostics = options.diagnostics ?? true;
  const registrations: vscode.Disposable[] = [
    vscode.languages.registerDefinitionProvider(SELECTOR, {
      async provideDefinition(document, position) {
        const word = findReferenceWord(document, position);
        if (!word) {
          return undefined;
        }
        const name = document.getText(word);
        const symbols = await store.symbolsByName(name);
        const relevant = symbols
          .filter((symbol) => symbol.kind !== "localization-reference")
          .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod"));
        if (relevant.length === 0) {
          return undefined;
        }
        return relevant.map(toLocation);
      },
    }),
    vscode.languages.registerReferenceProvider(SELECTOR, {
      async provideReferences(document, position) {
        const word = findReferenceWord(document, position);
        if (!word) {
          return undefined;
        }
        const name = document.getText(word);
        const references = await store.referencesByName(name);
        if (references.length === 0) {
          return [];
        }
        return references.map(toReferenceLocation);
      },
    }),
    vscode.languages.registerCompletionItemProvider(SELECTOR, {
      async provideCompletionItems(document, position) {
        const context = inferCompletionContext(
          document.lineAt(position.line).text.slice(0, position.character),
          recentDocumentText(document, position)
        );
        if (!context) {
          return undefined;
        }

        const symbols = await store.completionSymbols(context.kinds, context.query);
        if (symbols.length === 0) {
          return [];
        }

        const range = completionRange(document, position);
        return symbols.map((symbol) => {
          const item = new vscode.CompletionItem(
            context.prefix ? `${context.prefix}${symbol.name}` : symbol.name,
            toCompletionItemKind(symbol)
          );
          item.detail = `${symbol.kind} (${symbol.source})`;
          item.documentation = new vscode.MarkdownString(completionDocumentation(symbol));
          item.insertText = context.prefix ? `${context.prefix}${symbol.name}` : symbol.name;
          item.range = range;
          item.sortText = `${symbol.source === "mod" ? "0" : "1"}-${symbol.name}`;
          return item;
        });
      },
    }, ".", ":", "="),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
      provideDocumentSymbols(document) {
        const parsed = parseLiveDocument(document);
        if (!parsed || parsed.kind !== "script") {
          return [];
        }
        return parsed.entries
          .filter((entry) => entry.value.kind === "object")
          .map((entry) => {
            const kind =
              entry.key === "namespace"
                ? vscode.SymbolKind.Namespace
                : looksLikeEventId(entry.key)
                  ? vscode.SymbolKind.Event
                  : vscode.SymbolKind.Object;
            return new vscode.DocumentSymbol(
              entry.key,
              describeEntry(entry),
              kind,
              toVsRange(entry.range),
              toVsRange(entry.keyRange)
            );
          });
      },
    }),
    vscode.languages.registerWorkspaceSymbolProvider({
      async provideWorkspaceSymbols(query) {
        const symbols = await store.allSymbols(query);
        return symbols
          .filter((symbol) => symbol.kind !== "localization-reference")
          .map((symbol) => {
            const info = new vscode.SymbolInformation(
              symbol.name,
              toSymbolKind(symbol),
              symbol.containerName ?? "",
              toLocation(symbol)
            );
            return info;
          });
      },
      resolveWorkspaceSymbol(symbol) {
        return symbol;
      },
    })
  ];

  if (enableHover) {
    registrations.push(vscode.languages.registerHoverProvider(SELECTOR, {
      async provideHover(document, position) {
        const word = findReferenceWord(document, position);
        if (!word) {
          return undefined;
        }
        const parsed = parseLiveDocument(document);
        const name = document.getText(word);
        const syntaxHelp = getScriptSyntaxHelp(name, parsed ? syntaxHelpContextAt(parsed, word) : undefined);
        if (syntaxHelp) {
          const markdown = new vscode.MarkdownString(
            `**${syntaxHelp.id}**\n\n${syntaxHelp.title}\n\n${syntaxHelp.summary}\n\n${syntaxHelp.details.join("\n\n")}`
          );
          return new vscode.Hover(markdown, word);
        }
        const symbols = await store.symbolsByName(name);
        const target = symbols.find((item) => item.kind !== "localization-reference");
        if (!target) {
          return undefined;
        }
        const referenceCount = (await store.referencesByName(name)).length;
        const markdown = new vscode.MarkdownString(
          `**${target.name}**\n\nType: \`${target.kind}\`\n\nSource: \`${target.source}\`\n\nReferences: \`${referenceCount}\`\n\nPath: \`${target.path}\``
        );
        return new vscode.Hover(markdown, word);
      },
    }));
  }

  context.subscriptions.push(...registrations);

  if (!enableDiagnostics) {
    return;
  }
  const diagnostics = vscode.languages.createDiagnosticCollection("ck3ModDevkit");
  context.subscriptions.push(diagnostics);

  const refreshDiagnostics = async (document: vscode.TextDocument) => {
    if (!matchesCk3Document(document)) {
      return;
    }
    store.syncTextDocument(document);
    diagnostics.set(document.uri, await collectDiagnostics(document, store));
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => { void refreshDiagnostics(document); }),
    vscode.workspace.onDidChangeTextDocument((event) => { void refreshDiagnostics(event.document); }),
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      store.syncTextDocument(document);
      await store.refreshFor(document.uri);
      await refreshDiagnostics(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      store.removeDocument(document.uri);
      diagnostics.delete(document.uri);
    })
  );

  for (const document of vscode.workspace.textDocuments) {
    store.syncTextDocument(document);
    void refreshDiagnostics(document);
  }
}

function parseLiveDocument(document: vscode.TextDocument): ParsedDocument | undefined {
  if (document.fileName.endsWith(".yml")) {
    return parseLocalization(document.getText());
  }
  if (/\.(txt|gui|info|asset)$/.test(document.fileName)) {
    return parseScript(document.getText());
  }
  return undefined;
}

async function collectDiagnostics(document: vscode.TextDocument, store: IndexStore): Promise<vscode.Diagnostic[]> {
  const parsed = parseLiveDocument(document);
  if (!parsed) {
    return [];
  }

  const source = resolveDocumentSource(document.fileName);
  const results = await store.validateParsedDocument(parsed, document.fileName, source);
  return results.map((diagnostic) => new vscode.Diagnostic(
    toVsRange(diagnostic.range),
    diagnostic.message,
    diagnostic.severity === "error"
      ? vscode.DiagnosticSeverity.Error
      : diagnostic.severity === "warning"
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information
  ));
}

function matchesCk3Document(document: vscode.TextDocument): boolean {
  return /\.(txt|gui|info|asset|yml)$/.test(document.fileName);
}

function resolveDocumentSource(fileName: string): "mod" | "reference" {
  return resolveConfiguredSource(fileName, readConfig()) ?? "mod";
}

function syntaxHelpContextAt(parsed: ParsedDocument, range: vscode.Range): SyntaxHelpContext | undefined {
  if (parsed.kind !== "script") {
    return undefined;
  }
  return findEntryContext(parsed.entries, range, []);
}

function findEntryContext(entries: AssignmentNode[], range: vscode.Range, parents: string[]): SyntaxHelpContext | undefined {
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

function sameRange(left: Range, right: vscode.Range): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function findReferenceWord(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
  return document.getWordRangeAtPosition(position, /[\w.:-]+/);
}

function completionRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range {
  return findReferenceWord(document, position) ?? new vscode.Range(position, position);
}

function recentDocumentText(document: vscode.TextDocument, position: vscode.Position): string {
  const startLine = Math.max(position.line - 6, 0);
  const start = new vscode.Position(startLine, 0);
  return document.getText(new vscode.Range(start, position));
}

function toLocation(symbol: SymbolRecord): vscode.Location {
  return new vscode.Location(vscode.Uri.file(symbol.path), toVsRange(symbol.range));
}

function toReferenceLocation(reference: ReferenceRecord): vscode.Location {
  return new vscode.Location(vscode.Uri.file(reference.path), toVsRange(reference.range));
}

function toVsRange(range: Range): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function toSymbolKind(symbol: SymbolRecord): vscode.SymbolKind {
  switch (symbol.kind) {
    case "namespace":
      return vscode.SymbolKind.Namespace;
    case "event":
      return vscode.SymbolKind.Event;
    case "scripted_effect":
    case "scripted_trigger":
      return vscode.SymbolKind.Function;
    case "script_value":
      return vscode.SymbolKind.Variable;
    case "decision":
      return vscode.SymbolKind.Method;
    case "modifier":
      return vscode.SymbolKind.Constant;
    case "trait":
      return vscode.SymbolKind.EnumMember;
    case "culture":
    case "faith":
    case "religion":
      return vscode.SymbolKind.Class;
    case "cultural_tradition":
    case "cultural_pillar":
    case "doctrine":
      return vscode.SymbolKind.Enum;
    case "localization":
      return vscode.SymbolKind.String;
    default:
      return vscode.SymbolKind.Object;
  }
}

function toCompletionItemKind(symbol: SymbolRecord): vscode.CompletionItemKind {
  switch (symbol.kind) {
    case "event":
      return vscode.CompletionItemKind.Event;
    case "localization":
      return vscode.CompletionItemKind.Text;
    case "scripted_effect":
    case "scripted_trigger":
      return vscode.CompletionItemKind.Function;
    case "script_value":
      return vscode.CompletionItemKind.Variable;
    case "trait":
    case "doctrine":
    case "doctrine_parameter":
    case "cultural_tradition":
    case "cultural_pillar":
      return vscode.CompletionItemKind.EnumMember;
    case "modifier":
      return vscode.CompletionItemKind.Constant;
    case "culture":
    case "faith":
    case "religion":
      return vscode.CompletionItemKind.Class;
    case "artifact_type":
    case "artifact_template":
    case "artifact_visual":
      return vscode.CompletionItemKind.Value;
    default:
      return vscode.CompletionItemKind.Value;
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
