import { AssignmentNode, ListNode, ObjectNode, ParserError, Range, ScalarNode, ScriptDocument, ValueNode } from "./types";
import { TextCursor } from "./text";

type TokenKind = "identifier" | "string" | "number" | "operator" | "brace" | "bracket";

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

class Scanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scan(): Token[] {
    const tokens: Token[] = [];

    while (this.index < this.text.length) {
      const current = this.text[this.index];

      if (/\s/.test(current)) {
        this.index += 1;
        continue;
      }

      if (current === "#") {
        while (this.index < this.text.length && this.text[this.index] !== "\n") {
          this.index += 1;
        }
        continue;
      }

      if (current === "\"") {
        tokens.push(this.scanString());
        continue;
      }

      if ("{}[]".includes(current)) {
        tokens.push({
          kind: current === "{" || current === "}" ? "brace" : "bracket",
          value: current,
          start: this.index,
          end: this.index + 1,
        });
        this.index += 1;
        continue;
      }

      if (["=", "<", ">", "!"].includes(current)) {
        const start = this.index;
        this.index += 1;
        if (this.text[this.index] === "=") {
          this.index += 1;
        }
        tokens.push({
          kind: "operator",
          value: this.text.slice(start, this.index),
          start,
          end: this.index,
        });
        continue;
      }

      if (/[0-9-]/.test(current)) {
        const token = this.scanNumberOrIdentifier();
        tokens.push(token);
        continue;
      }

      tokens.push(this.scanIdentifier());
    }

    return tokens;
  }

  private scanString(): Token {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const current = this.text[this.index];
      if (current === "\\") {
        this.index += 2;
        continue;
      }
      if (current === "\"") {
        this.index += 1;
        break;
      }
      this.index += 1;
    }
    return {
      kind: "string",
      value: this.text.slice(start + 1, Math.max(start + 1, this.index - 1)),
      start,
      end: this.index,
    };
  }

  private scanNumberOrIdentifier(): Token {
    const start = this.index;
    while (this.index < this.text.length && /[A-Za-z0-9_.:-]/.test(this.text[this.index])) {
      this.index += 1;
    }
    const value = this.text.slice(start, this.index);
    const kind: TokenKind = /^-?\d+(?:\.\d+)?$/.test(value) ? "number" : "identifier";
    return { kind, value, start, end: this.index };
  }

  private scanIdentifier(): Token {
    const start = this.index;
    while (this.index < this.text.length && /[A-Za-z0-9_:.@/-]/.test(this.text[this.index])) {
      this.index += 1;
    }
    if (this.index === start) {
      this.index += 1;
    }
    return {
      kind: "identifier",
      value: this.text.slice(start, this.index),
      start,
      end: this.index,
    };
  }
}

class Parser {
  private index = 0;
  readonly errors: ParserError[] = [];

  constructor(private readonly tokens: Token[], private readonly cursor: TextCursor) {}

  parseDocument(text: string): ScriptDocument {
    const entries = this.parseAssignmentsUntil();
    const end = this.tokens.length > 0 ? this.tokens[this.tokens.length - 1].end : 0;
    return {
      kind: "script",
      entries,
      range: this.cursor.range(0, end),
      errors: this.errors,
      text,
    };
  }

  private parseAssignmentsUntil(until?: string): AssignmentNode[] {
    const entries: AssignmentNode[] = [];
    while (!this.isAtEnd()) {
      const token = this.peek();
      if (until && token?.value === until) {
        break;
      }
      const entry = this.parseAssignment();
      if (entry) {
        entries.push(entry);
      } else {
        this.index += 1;
      }
    }
    return entries;
  }

  private parseAssignment(): AssignmentNode | null {
    const key = this.peek();
    const operator = this.peek(1);
    if (!key || !operator || !["identifier", "number", "string"].includes(key.kind) || operator.value !== "=") {
      return null;
    }

    this.index += 2;
    const value = this.parseValue();
    if (!value) {
      const fallbackRange = this.cursor.range(key.start, operator.end);
      this.errors.push({ message: "Expected a value after '='.", range: fallbackRange });
      return null;
    }

    return {
      key: key.value,
      keyRange: this.cursor.range(key.start, key.end),
      operator: operator.value,
      operatorRange: this.cursor.range(operator.start, operator.end),
      value,
      range: this.cursor.range(key.start, value.range.end.offset),
    };
  }

  private parseValue(): ValueNode | null {
    const token = this.peek();
    if (!token) {
      return null;
    }

    if (token.value === "{") {
      return this.parseObject();
    }

    if (token.value === "[") {
      return this.parseList();
    }

    this.index += 1;
    return this.scalarFromToken(token);
  }

  private parseObject(): ObjectNode {
    const start = this.consume("{");
    const entries = this.parseAssignmentsUntil("}");
    const endToken = this.peek();
    if (!endToken || endToken.value !== "}") {
      this.errors.push({
        message: "Missing closing '}'",
        range: this.cursor.range(start.start, start.end),
      });
      return {
        kind: "object",
        entries,
        range: this.cursor.range(start.start, entries.length > 0 ? entries[entries.length - 1].range.end.offset : start.end),
      };
    }

    this.index += 1;
    return {
      kind: "object",
      entries,
      range: this.cursor.range(start.start, endToken.end),
    };
  }

  private parseList(): ListNode {
    const start = this.consume("[");
    const items: ValueNode[] = [];
    while (!this.isAtEnd() && this.peek()?.value !== "]") {
      const value = this.parseValue();
      if (value) {
        items.push(value);
      } else {
        this.index += 1;
      }
    }

    const endToken = this.peek();
    if (!endToken || endToken.value !== "]") {
      this.errors.push({
        message: "Missing closing ']'",
        range: this.cursor.range(start.start, start.end),
      });
      return {
        kind: "list",
        items,
        range: this.cursor.range(start.start, items.length > 0 ? items[items.length - 1].range.end.offset : start.end),
      };
    }

    this.index += 1;
    return {
      kind: "list",
      items,
      range: this.cursor.range(start.start, endToken.end),
    };
  }

  private scalarFromToken(token: Token): ScalarNode {
    const kind = token.kind === "string" || token.kind === "number" || token.kind === "identifier" || token.kind === "operator"
      ? token.kind
      : "identifier";
    return {
      kind,
      value: token.value,
      range: this.cursor.range(token.start, token.end),
    };
  }

  private consume(value: string): Token {
    const token = this.peek();
    if (!token || token.value !== value) {
      throw new Error(`Expected token '${value}'.`);
    }
    this.index += 1;
    return token;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  private isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }
}

export function parseScript(text: string): ScriptDocument {
  const cursor = new TextCursor(text);
  const scanner = new Scanner(text);
  const parser = new Parser(scanner.scan(), cursor);
  return parser.parseDocument(text);
}

export function findAssignments(entries: AssignmentNode[], key: string): AssignmentNode[] {
  const results: AssignmentNode[] = [];
  for (const entry of entries) {
    if (entry.key === key) {
      results.push(entry);
    }
    if (entry.value.kind === "object") {
      results.push(...findAssignments(entry.value.entries, key));
    }
  }
  return results;
}

export function scalarValue(node: ValueNode): string | null {
  return node.kind === "object" || node.kind === "list" ? null : node.value;
}

export function flattenEntries(entries: AssignmentNode[]): AssignmentNode[] {
  const flattened: AssignmentNode[] = [];
  for (const entry of entries) {
    flattened.push(entry);
    if (entry.value.kind === "object") {
      flattened.push(...flattenEntries(entry.value.entries));
    }
  }
  return flattened;
}
