import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  CodeAction,
  CodeActionKind,
  CompletionItemKind,
  CreateFile,
  Diagnostic,
  DocumentDiagnosticReportKind,
  FullDocumentDiagnosticReport,
  InlayHint,
  OptionalVersionedTextDocumentIdentifier,
  Position,
  Range,
  SemanticTokensBuilder,
  SymbolKind,
  TextEdit,
  TextDocumentEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from "vscode-languageserver/node";
import { scalarValue } from "../core/parser";
import { AssignmentNode, LocalizationEntry, ParsedDocument, Range as CoreRange, SymbolRecord } from "../core/types";

export const SEMANTIC_TOKEN_TYPES = [
  "comment",
  "string",
  "number",
  "operator",
  "property",
  "namespace",
  "event",
  "function",
  "variable",
  "enumMember",
  "class",
  "enum",
] as const;

const TOKEN_TYPE_INDEX = new Map<string, number>(SEMANTIC_TOKEN_TYPES.map((type, index) => [type, index]));

export function buildSemanticTokens(parsed: ParsedDocument): { data: number[] } {
  const builder = new SemanticTokensBuilder();
  const tokens: Array<{ line: number; char: number; length: number; type: number }> = [];

  pushRegexTokens(tokens, parsed.text, /#[^\n\r]*/g, "comment");
  pushRegexTokens(tokens, parsed.text, /"([^"\\]|\\.)*"/g, "string");
  pushRegexTokens(tokens, parsed.text, /(^|[=\s\[{])(-?\d+(?:\.\d+)?)(?=$|[\s\]}])/gm, "number", 2);
  pushRegexTokens(tokens, parsed.text, /(<=|>=|!=|=|<|>|\{|\}|\[|\])/g, "operator");
  pushRegexTokens(tokens, parsed.text, /\b[a-zA-Z0-9_]+\.\d+\b/g, "event");
  pushRegexTokens(tokens, parsed.text, /\b(?:var|local_var|global_var|named_script_value|named_script_value_item):[\w.-]+\b/g, "variable");
  pushRegexTokens(tokens, parsed.text, /\b(?:scope|event_target):[\w.-]+\b/g, "class");
  pushRegexTokens(tokens, parsed.text, /\b(?:doctrine|doctrine_parameter|cultural_tradition|cultural_pillar):[\w.-]+\b/g, "enum");
  pushRegexTokens(tokens, parsed.text, /\b(?:trait):[\w.-]+\b/g, "enumMember");
  pushRegexTokens(tokens, parsed.text, /\b(?:culture|faith|religion):[\w.-]+\b/g, "class");
  pushRegexTokens(tokens, parsed.text, /\b(?:scripted_effect|scripted_trigger):[\w.-]+\b/g, "function");

  if (parsed.kind === "script") {
    for (const entry of flattenScriptEntries(parsed.entries)) {
      pushRangeToken(tokens, entry.keyRange, semanticTypeForEntry(entry));
    }
  } else {
    for (const entry of parsed.entries) {
      pushRangeToken(tokens, entry.range, "property", entry.key.length);
    }
  }

  tokens
    .sort((left, right) => left.line - right.line || left.char - right.char || left.type - right.type)
    .forEach((token) => builder.push(token.line, token.char, token.length, token.type, 0));

  return builder.build();
}

export function buildInlayHints(parsed: ParsedDocument, filePath: string, symbols: SymbolRecord[]): InlayHint[] {
  if (parsed.kind !== "script") {
    return [];
  }

  const relevant = symbols.filter((symbol) => path.resolve(symbol.path) === path.resolve(filePath) && symbol.kind !== "localization-reference");
  const symbolByOffset = new Map<number, SymbolRecord>();
  for (const symbol of relevant) {
    symbolByOffset.set(symbol.range.start.offset, symbol);
  }

  const hints: InlayHint[] = [];
  for (const entry of flattenScriptEntries(parsed.entries)) {
    const symbol = symbolByOffset.get(entry.keyRange.start.offset);
    if (!symbol) {
      continue;
    }
    hints.push({
      position: {
        line: entry.keyRange.end.line,
        character: entry.keyRange.end.character,
      },
      label: ` ${symbol.kind}`,
      kind: 1,
      paddingLeft: true,
    });
  }

  return hints;
}

export function buildRenameWorkspaceEdit(newName: string, symbols: SymbolRecord[], references: Array<{ path: string; range: CoreRange }>): WorkspaceEdit {
  const changes = new Map<string, TextEdit[]>();
  for (const symbol of symbols) {
    appendEdit(changes, pathToFileURL(symbol.path).toString(), symbol.range, newName);
  }
  for (const reference of references) {
    appendEdit(changes, pathToFileURL(reference.path).toString(), reference.range, newName);
  }
  return {
    changes: Object.fromEntries(changes.entries()),
  };
}

export function buildDocumentDiagnosticReport(items: Diagnostic[]): FullDocumentDiagnosticReport {
  return {
    kind: DocumentDiagnosticReportKind.Full,
    items,
  };
}

export function createMissingLocalizationCodeAction(
  diagnostic: Diagnostic,
  symbolName: string,
  localizationFilePath: string | null
): CodeAction | null {
  if (!localizationFilePath) {
    return null;
  }

  const insertPosition = endOfFilePosition(localizationFilePath);
  return {
    title: `Create localization key '${symbolName}'`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: {
      changes: {
        [pathToFileURL(localizationFilePath).toString()]: [
          {
            range: {
              start: insertPosition,
              end: insertPosition,
            },
            newText: `${ensureTrailingNewline(localizationFilePath)} ${symbolName}:0 "TODO"\n`,
          },
        ],
      },
    },
  };
}

export function createMissingScriptDefinitionCodeAction(
  diagnostic: Diagnostic,
  symbolName: string,
  kind: "scripted_effect" | "scripted_trigger" | "script_value",
  filePath: string | null
): CodeAction | null {
  if (!filePath) {
    return null;
  }

  const stub = scriptDefinitionStub(symbolName, kind);
  if (!stub) {
    return null;
  }

  return {
    title: `Create ${kind} '${symbolName}'`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: appendOrCreateWorkspaceEdit(filePath, stub),
  };
}

export function createAddUtf8BomCodeAction(diagnostic: Diagnostic, documentUri: string): CodeAction {
  return {
    title: "Add UTF-8 BOM",
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: {
      changes: {
        [documentUri]: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "\uFEFF",
        }],
      },
    },
  };
}

export function createConvertGuiTextToRawTextCodeAction(
  diagnostic: Diagnostic,
  documentUri: string,
  symbolName: string,
  line: number,
  keyStart: number,
  keyEnd: number,
  valueStart: number,
  valueEnd: number
): CodeAction {
  return {
    title: `Convert text to raw_text for '${symbolName}'`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: {
      changes: {
        [documentUri]: [
          {
            range: {
              start: { line, character: keyStart },
              end: { line, character: keyEnd },
            },
            newText: "raw_text",
          },
          {
            range: {
              start: { line, character: valueStart },
              end: { line, character: valueEnd },
            },
            newText: `"${symbolName}"`,
          },
        ],
      },
    },
  };
}

export function createMissingEventCodeAction(
  diagnostic: Diagnostic,
  eventId: string,
  filePath: string | null
): CodeAction | null {
  if (!filePath) {
    return null;
  }
  const namespace = eventId.includes(".") ? eventId.split(".")[0] : "generated";
  const stub = `namespace = ${namespace}\n\n${eventId} = {\n}\n`;
  return {
    title: `Create event '${eventId}'`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: appendOrCreateWorkspaceEdit(filePath, stub),
  };
}

export function toWorkspaceSymbol(symbol: SymbolRecord): WorkspaceSymbol {
  return {
    name: symbol.name,
    kind: toSymbolKind(symbol.kind),
    location: {
      uri: pathToFileURL(symbol.path).toString(),
      range: toLspRange(symbol.range),
    },
    containerName: symbol.containerName ?? "",
  };
}

export function toCompletionItemKind(symbolKind: string): CompletionItemKind {
  switch (symbolKind) {
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
    default:
      return CompletionItemKind.Value;
  }
}

export function completionDocumentation(symbol: SymbolRecord): string {
  const container = symbol.containerName ? `\n\nContainer: \`${symbol.containerName}\`` : "";
  return `**${symbol.name}**\n\nType: \`${symbol.kind}\`\n\nSource: \`${symbol.source}\`\n\nPath: \`${symbol.path}\`${container}`;
}

export function buildHoverMarkdown(
  symbol: SymbolRecord,
  referenceCount: number,
  definitionCount: number,
  snippet?: string,
  localizationText?: string,
  localizationLanguage?: string | null
): string {
  const lines = [
    `**${symbol.name}**`,
    "",
    `Type: \`${symbol.kind}\``,
    `Source: \`${symbol.source}\``,
  ];

  if (localizationText) {
    lines.push("");
    lines.push(`Text: "${escapeInlineQuote(localizationText)}"`);
    if (localizationLanguage) {
      lines.push(`Language: \`${localizationLanguage}\``);
    }
  }

  if (symbol.containerName) {
    lines.push(`Container: \`${symbol.containerName}\``);
  }

  lines.push(`Definitions: \`${definitionCount}\``);
  lines.push(`References: \`${referenceCount}\``);
  lines.push(`Location: \`${path.basename(symbol.path)}:${symbol.range.start.line + 1}\``);
  lines.push("");
  lines.push(`Path: \`${symbol.path}\``);

  if (snippet) {
    lines.push("");
    lines.push("```ck3-script");
    lines.push(snippet);
    lines.push("```");
  }

  return lines.join("\n");
}

export function toSymbolKind(symbolKind: string): SymbolKind {
  switch (symbolKind) {
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

export function describeEntry(entry: AssignmentNode): string {
  const value = scalarValue(entry.value);
  if (value) {
    return value;
  }
  return entry.value.kind;
}

export function toLspRange(range: CoreRange): Range {
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

function appendEdit(target: Map<string, TextEdit[]>, uri: string, range: CoreRange, newText: string): void {
  const existing = target.get(uri) ?? [];
  existing.push({
    range: toLspRange(range),
    newText,
  });
  target.set(uri, existing);
}

function appendOrCreateWorkspaceEdit(filePath: string, text: string): WorkspaceEdit {
  const uri = pathToFileURL(filePath).toString();
  if (fs.existsSync(filePath)) {
    const insertPosition = endOfFilePosition(filePath);
    return {
      changes: {
        [uri]: [{
          range: {
            start: insertPosition,
            end: insertPosition,
          },
          newText: `${ensureTrailingNewline(filePath)}${text}`,
        }],
      },
    };
  }

  const createFile: CreateFile = {
    kind: "create",
    uri,
  };
  const documentEdit: TextDocumentEdit = {
    textDocument: {
      uri,
      version: null,
    } as OptionalVersionedTextDocumentIdentifier,
    edits: [{
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      newText: text,
    }],
  };
  return {
    documentChanges: [createFile, documentEdit],
  };
}

function flattenScriptEntries(entries: AssignmentNode[]): AssignmentNode[] {
  const flattened: AssignmentNode[] = [];
  for (const entry of entries) {
    flattened.push(entry);
    if (entry.value.kind === "object") {
      flattened.push(...flattenScriptEntries(entry.value.entries));
    }
  }
  return flattened;
}

function semanticTypeForEntry(entry: AssignmentNode): string {
  if (entry.key === "namespace") {
    return "namespace";
  }
  if (/^[a-zA-Z0-9_]+\.\d+$/.test(entry.key)) {
    return "event";
  }
  if (entry.key.endsWith("_effect")) {
    return "function";
  }
  if (entry.key.endsWith("_trigger")) {
    return "function";
  }
  if (entry.key.endsWith("_value")) {
    return "variable";
  }
  return "property";
}

function scriptDefinitionStub(
  symbolName: string,
  kind: "scripted_effect" | "scripted_trigger" | "script_value"
): string | null {
  switch (kind) {
    case "scripted_effect":
      return `${symbolName} = {\n}\n`;
    case "scripted_trigger":
      return `${symbolName} = {\n  always = yes\n}\n`;
    case "script_value":
      return `${symbolName} = 0\n`;
    default:
      return null;
  }
}

function escapeInlineQuote(value: string): string {
  return value.replace(/"/g, "\\\"");
}

function pushRegexTokens(
  tokens: Array<{ line: number; char: number; length: number; type: number }>,
  text: string,
  pattern: RegExp,
  tokenType: string,
  captureGroup = 0
): void {
  const type = TOKEN_TYPE_INDEX.get(tokenType);
  if (type === undefined) {
    return;
  }
  for (const match of text.matchAll(pattern)) {
    const value = match[captureGroup];
    if (!value) {
      continue;
    }
    const index = match.index ?? 0;
    const offset = captureGroup === 0 ? index : index + match[0].indexOf(value);
    const lineInfo = offsetToLineCharacter(text, offset);
    tokens.push({
      line: lineInfo.line,
      char: lineInfo.character,
      length: value.length,
      type,
    });
  }
}

function pushRangeToken(
  tokens: Array<{ line: number; char: number; length: number; type: number }>,
  range: CoreRange,
  tokenType: string,
  length = range.end.character - range.start.character
): void {
  const type = TOKEN_TYPE_INDEX.get(tokenType);
  if (type === undefined || length <= 0) {
    return;
  }
  tokens.push({
    line: range.start.line,
    char: range.start.character,
    length,
    type,
  });
}

function offsetToLineCharacter(text: string, offset: number): Position {
  let line = 0;
  let character = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }
  return { line, character };
}

function ensureTrailingNewline(filePath: string): string {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  return text.endsWith("\n") || text.length === 0 ? "" : "\n";
}

function endOfFilePosition(filePath: string): Position {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  return offsetToLineCharacter(text, text.length);
}
