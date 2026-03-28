export interface Position {
  line: number;
  character: number;
  offset: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface ParserError {
  message: string;
  range: Range;
}

export type TokenKind = "identifier" | "string" | "number" | "operator" | "brace" | "bracket";

export interface ScriptToken {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

export type ScalarKind = "identifier" | "string" | "number" | "operator";

export interface ScalarNode {
  kind: ScalarKind;
  value: string;
  range: Range;
}

export interface AssignmentNode {
  key: string;
  keyRange: Range;
  operator: string;
  operatorRange: Range;
  value: ValueNode;
  range: Range;
}

export interface ObjectNode {
  kind: "object";
  entries: AssignmentNode[];
  range: Range;
}

export interface ListNode {
  kind: "list";
  items: ValueNode[];
  range: Range;
}

export type ValueNode = ScalarNode | ObjectNode | ListNode;

export interface ScriptDocument {
  kind: "script";
  entries: AssignmentNode[];
  range: Range;
  errors: ParserError[];
  text: string;
  tokens: ScriptToken[];
}

export interface LocalizationEntry {
  key: string;
  value: string;
  range: Range;
}

export interface LocalizationDocument {
  kind: "localization";
  language: string | null;
  entries: LocalizationEntry[];
  errors: ParserError[];
  text: string;
}

export type ParsedDocument = ScriptDocument | LocalizationDocument;

export interface SymbolRecord {
  name: string;
  kind: string;
  path: string;
  range: Range;
  containerName?: string;
  source: "mod" | "reference";
}

export interface ReferenceRecord {
  name: string;
  kind: string;
  path: string;
  range: Range;
  source: "mod" | "reference";
}
