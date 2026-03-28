import { parentPort, workerData } from "worker_threads";
import { buildCachedWorkspaceIndex } from "../cli-shared";
import { WorkspaceIndex } from "../core/indexer";
import { ParsedDocument, ReferenceRecord, SymbolRecord } from "../core/types";

interface WorkerInput {
  modRoots: string[];
  referenceRoots: string[];
  maxFiles: number;
}

interface SerializedWorkspaceIndex {
  symbols: Array<[string, SymbolRecord[]]>;
  references: Array<[string, ReferenceRecord[]]>;
  documents: Array<[string, ParsedDocument]>;
  files: string[];
}

function serializeIndex(index: WorkspaceIndex): SerializedWorkspaceIndex {
  return {
    symbols: Array.from(index.symbols.entries()),
    references: Array.from(index.references.entries()),
    documents: Array.from(index.documents.entries()),
    files: index.files,
  };
}

try {
  const index = buildCachedWorkspaceIndex({
    ...(workerData as WorkerInput),
    trustReferenceCaches: true,
  });
  parentPort?.postMessage({
    ok: true,
    index: serializeIndex(index),
  });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
