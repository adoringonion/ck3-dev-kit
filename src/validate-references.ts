import * as fs from "fs";
import * as path from "path";
import { buildIndexFromArgs, writeError, writeJson } from "./cli-shared";
import { validateDocumentFileAgainstIndex, validateReferences } from "./core/references";

function main(): void {
  const args = process.argv.slice(2);
  const candidate = args[0]?.startsWith("--") ? undefined : args[0];
  const fileArg = candidate && isExistingFile(candidate) ? candidate : undefined;
  const offset = fileArg ? 1 : 0;

  try {
    const index = buildIndexFromArgs(args.slice(offset));
    const diagnostics = fileArg
      ? validateDocumentFileAgainstIndex(index, path.resolve(process.cwd(), fileArg))
      : validateReferences(index);

    writeJson({
      ok: diagnostics.length === 0,
      file: fileArg ? path.resolve(process.cwd(), fileArg) : null,
      diagnostics: diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        name: diagnostic.name,
        kind: diagnostic.referenceKind,
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
      })),
    });

    if (diagnostics.length > 0) {
      process.exit(2);
    }
  } catch (error) {
    writeError("Failed to validate references.", 1, error instanceof Error ? error.message : String(error));
  }
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(path.resolve(process.cwd(), filePath)).isFile();
  } catch {
    return false;
  }
}

main();
