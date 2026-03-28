import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { TextDocument } from "vscode-languageserver-textdocument";
import { buildCachedWorkspaceIndex, resolveRoots } from "./cli-shared";
import { RequestContext } from "./lsp/requestContext";
import { ServerState } from "./lsp/serverState";

function main(): void {
  const args = process.argv.slice(2);
  const roots = resolveRoots(args);
  const sampleLimit = Number.parseInt(args[2] ?? "25", 10);

  const indexStarted = performance.now();
  const index = buildCachedWorkspaceIndex({
    modRoots: roots.modRoots,
    referenceRoots: roots.referenceRoots,
    maxFiles: 20000,
    trustReferenceCaches: true,
  });
  const indexElapsedMs = performance.now() - indexStarted;

  const state = new ServerState();
  state.setConfig({
    modRoots: roots.modRoots,
    referenceRoots: roots.referenceRoots,
    maxFiles: 20000,
  });
  state.setIndex(index);

  const modFiles = [...index.documents.keys()]
    .filter((filePath) => state.resolveSource(filePath) === "mod")
    .slice(0, Math.max(sampleLimit, 1));

  const diagnosticsStarted = performance.now();
  let diagnosticsCount = 0;
  for (const filePath of modFiles) {
    const parsed = index.documents.get(filePath);
    if (!parsed) {
      continue;
    }
    const diagnostics = state.collectIndexedDiagnostics(filePath, parsed, new RequestContext({ label: "benchmark diagnostics" }));
    diagnosticsCount += diagnostics.length;
  }
  const diagnosticsElapsedMs = performance.now() - diagnosticsStarted;

  const openStarted = performance.now();
  for (const filePath of modFiles.slice(0, Math.min(modFiles.length, 10))) {
    const text = fs.readFileSync(filePath, "utf8");
    const document = TextDocument.create(pathToFileURL(filePath).toString(), languageIdForPath(filePath), 1, text);
    state.openDocument(document);
  }
  const openElapsedMs = performance.now() - openStarted;

  const snapshot = state.snapshot();
  const queryContext = new RequestContext({ label: "benchmark queries" });

  const workspaceSymbolsStarted = performance.now();
  const workspaceSymbols = snapshot.workspaceSymbols("war", queryContext);
  const workspaceSymbolsElapsedMs = performance.now() - workspaceSymbolsStarted;

  const completionStarted = performance.now();
  const completionSymbols = snapshot.completionSymbols(["scripted_effect", "scripted_trigger", "script_value"], "show", 100, queryContext);
  const completionElapsedMs = performance.now() - completionStarted;

  const result = {
    ok: true,
    roots,
    samples: {
      indexedFiles: index.files.length,
      sampledModFiles: modFiles.length,
    },
    timingsMs: {
      indexBuild: round(indexElapsedMs),
      sampledIndexedDiagnostics: round(diagnosticsElapsedMs),
      sampledOpenHydration: round(openElapsedMs),
      workspaceSymbols: round(workspaceSymbolsElapsedMs),
      completionSymbols: round(completionElapsedMs),
    },
    counts: {
      diagnostics: diagnosticsCount,
      workspaceSymbols: workspaceSymbols.length,
      completionSymbols: completionSymbols.length,
    },
    queryStats: state.queryStats(),
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function languageIdForPath(filePath: string): string {
  return /\.yml$/i.test(filePath) ? "ck3-localization" : "ck3-script";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main();
