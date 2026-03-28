import { LocalizationDocument, LocalizationEntry, ParserError } from "./types";
import { TextCursor } from "./text";

export function parseLocalization(text: string): LocalizationDocument {
  const cursor = new TextCursor(text);
  const lines = text.split(/\r?\n/);
  const entries: LocalizationEntry[] = [];
  const errors: ParserError[] = [];
  let language: string | null = null;
  let offset = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      offset += line.length + 1;
      continue;
    }

    const languageMatch = /^\s*(l_[a-z_]+)\s*:\s*$/.exec(line);
    if (languageMatch) {
      language = languageMatch[1];
      offset += line.length + 1;
      continue;
    }

    const entryMatch = /^\s*([\w.:-]+)\s*:\d*\s*"((?:\\"|[^"])*)"/.exec(line);
    if (!entryMatch) {
      if (trimmed.includes(":")) {
        errors.push({
          message: "Could not parse localization entry.",
          range: cursor.range(offset, offset + line.length),
        });
      }
      offset += line.length + 1;
      continue;
    }

    const key = entryMatch[1];
    const value = entryMatch[2].replace(/\\"/g, "\"");
    const keyStart = line.indexOf(key);
    entries.push({
      key,
      value,
      range: cursor.range(offset + keyStart, offset + keyStart + key.length),
    });
    offset += line.length + 1;
  }

  return {
    kind: "localization",
    language,
    entries,
    errors,
    text,
  };
}
