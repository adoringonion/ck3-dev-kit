import * as path from "path";
import { writeError, writeJson } from "./cli-shared";
import { parseDocumentFile } from "./core/document";

function main(): void {
  const args = process.argv.slice(2);
  const fileArg = args[0];
  if (!fileArg) {
    writeError("Usage: npm run parse-file -- <file>", 1);
  }

  const file = path.resolve(process.cwd(), fileArg);

  try {
    const parsed = parseDocumentFile(file);
    if (parsed.kind === "localization") {
      writeJson({
        ok: true,
        kind: parsed.kind,
        path: file,
        language: parsed.language,
        entryCount: parsed.entries.length,
        errors: parsed.errors,
        entries: parsed.entries.map((entry) => ({
          key: entry.key,
          value: entry.value,
          line: entry.range.start.line + 1,
          character: entry.range.start.character + 1,
        })),
      });
      return;
    }

    writeJson({
      ok: true,
      kind: parsed.kind,
      path: file,
      entryCount: parsed.entries.length,
      errors: parsed.errors,
      entries: parsed.entries.map((entry) => ({
        key: entry.key,
        operator: entry.operator,
        valueKind: entry.value.kind,
        line: entry.range.start.line + 1,
        character: entry.range.start.character + 1,
      })),
    });
  } catch (error) {
    writeError("Failed to parse file.", 1, error instanceof Error ? error.message : String(error));
  }
}

main();
