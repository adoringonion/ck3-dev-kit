import { buildIndexFromArgs, writeError, writeJson } from "./cli-shared";
import { findReferences } from "./core/references";

function main(): void {
  const args = process.argv.slice(2);
  const query = args[0];
  if (!query) {
    writeError("Usage: npm run find-references -- <symbol> [modRoot] [referenceRoot]", 1);
  }

  const index = buildIndexFromArgs(args.slice(1));
  const results = findReferences(index, query)
    .filter((reference) => reference.source === "mod")
    .map((reference) => ({
      name: reference.name,
      kind: reference.kind,
      path: reference.path,
      line: reference.range.start.line + 1,
      character: reference.range.start.character + 1,
      source: reference.source,
    }));

  if (results.length === 0) {
    writeJson({
      ok: false,
      query,
      results: [],
    });
    process.exit(2);
  }

  writeJson({
    ok: true,
    query,
    results,
  });
}

main();
