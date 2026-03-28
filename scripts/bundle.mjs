import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});

await build({
  ...shared,
  entryPoints: ["src/lsp/server.ts"],
  outfile: "dist/lsp/server.js",
});

await build({
  ...shared,
  entryPoints: ["src/lsp/indexWorker.ts"],
  outfile: "dist/lsp/indexWorker.js",
});

await build({
  ...shared,
  entryPoints: ["src/lsp/documentWorker.ts"],
  outfile: "dist/lsp/documentWorker.js",
});
