import { buildIndexFromArgs, writeError, writeJson } from "./cli-shared";

function main(): void {
  const args = process.argv.slice(2);
  const query = args[0];
  if (!query) {
    writeError("Usage: node dist/find-symbol.js <symbol> [modRoot] [referenceRoot]", 1);
  }

  const index = buildIndexFromArgs(args.slice(1));
  const results = (index.symbols.get(query) ?? [])
    .filter((entry) => entry.kind !== "localization-reference")
    .map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
      line: entry.range.start.line + 1,
      character: entry.range.start.character + 1,
      source: entry.source,
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
