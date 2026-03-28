import { buildIndexFromArgs, writeJson } from "./cli-shared";

function main(): void {
  const args = process.argv.slice(2);
  const index = buildIndexFromArgs(args);

  const summary = Array.from(index.symbols.entries())
    .slice(0, 50)
    .map(([name, entries]) => ({
      name,
      definitions: entries
        .filter((entry) => entry.kind !== "localization-reference")
        .map((entry) => ({
          kind: entry.kind,
          path: entry.path,
          line: entry.range.start.line + 1,
          source: entry.source,
        })),
    }));

  writeJson({
    ok: true,
    files: index.files.length,
    uniqueSymbols: index.symbols.size,
    sample: summary,
  });
}

main();
