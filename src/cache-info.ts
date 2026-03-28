import { inspectCachesFromArgs, writeJson } from "./cli-shared";

function main(): void {
  writeJson(inspectCachesFromArgs(process.argv.slice(2)));
}

main();
