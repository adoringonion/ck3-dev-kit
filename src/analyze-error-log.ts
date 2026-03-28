import * as fs from "fs";
import * as path from "path";
import { buildIndexFromArgs, resolveRoots, writeError, writeJson } from "./cli-shared";
import { analyzeErrorLogFile, defaultCk3ErrorLogPath } from "./core/errorLog";

function main(): void {
  const args = process.argv.slice(2);
  const candidate = args[0]?.startsWith("--") ? undefined : args[0];
  const fileArg = candidate && isExistingFile(candidate) ? candidate : undefined;
  const offset = fileArg ? 1 : 0;
  const logPath = path.resolve(process.cwd(), fileArg ?? defaultCk3ErrorLogPath());

  if (!fs.existsSync(logPath)) {
    writeError("CK3 error.log was not found.", 1, { logPath });
  }

  try {
    const rootArgs = args.slice(offset);
    const index = buildIndexFromArgs(rootArgs);
    const roots = resolveRoots(rootArgs);
    const result = analyzeErrorLogFile({
      logPath,
      modRoots: roots.modRoots,
      referenceRoots: roots.referenceRoots,
      index,
    });
    writeJson(result);
    if (!result.ok) {
      process.exit(2);
    }
  } catch (error) {
    writeError("Failed to analyze CK3 error.log.", 1, error instanceof Error ? error.message : String(error));
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
