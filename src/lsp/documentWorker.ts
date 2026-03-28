import { parentPort, workerData } from "worker_threads";
import { createIncrementalDocumentIndexRecord } from "../core/incremental";
import { ParsedDocument, ReferenceRecord, SymbolRecord } from "../core/types";

interface WorkerInput {
  filePath: string;
  text: string;
  source: "mod" | "reference";
  previous?: ParsedDocument;
}

interface WorkerOutput {
  parsed: ParsedDocument;
  symbols: SymbolRecord[];
  references: ReferenceRecord[];
}

try {
  const input = workerData as WorkerInput;
  const record = createIncrementalDocumentIndexRecord(input.filePath, input.text, input.source, input.previous);
  const output: WorkerOutput = {
    parsed: record.parsed,
    symbols: record.symbols,
    references: record.references,
  };
  parentPort?.postMessage({
    ok: true,
    record: output,
  });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
