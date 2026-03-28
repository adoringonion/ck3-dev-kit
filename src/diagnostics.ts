import * as path from "path";
import { writeError, writeJson } from "./cli-shared";
import { collectDocumentDiagnostics } from "./core/diagnostics";
import { parseDocumentFile } from "./core/document";

function main(): void {
  const args = process.argv.slice(2);
  const fileArg = args[0];
  if (!fileArg) {
    writeError("Usage: npm run diagnostics -- <file>", 1);
  }

  const file = path.resolve(process.cwd(), fileArg);

  try {
    const parsed = parseDocumentFile(file);
    const diagnostics = collectDocumentDiagnostics(parsed).map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
      line: diagnostic.range.start.line + 1,
      character: diagnostic.range.start.character + 1,
      endLine: diagnostic.range.end.line + 1,
      endCharacter: diagnostic.range.end.character + 1,
    }));

    writeJson({
      ok: diagnostics.length === 0,
      kind: parsed.kind,
      path: file,
      diagnostics,
    });

    if (diagnostics.length > 0) {
      process.exit(2);
    }
  } catch (error) {
    writeError("Failed to compute diagnostics.", 1, error instanceof Error ? error.message : String(error));
  }
}

main();
