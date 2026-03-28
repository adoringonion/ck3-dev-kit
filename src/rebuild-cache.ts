import { rebuildCachesFromArgs, writeJson } from "./cli-shared";

function main(): void {
  writeJson(rebuildCachesFromArgs(process.argv.slice(2)));
}

main();
