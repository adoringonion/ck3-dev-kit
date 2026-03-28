import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  collectWorkspaceFiles,
  createDocumentIndexRecord,
  createWorkspaceIndexFromCollectedFiles,
  WorkspaceFileRecord,
  WorkspaceIndex,
} from "./core/indexer";
import { ParsedDocument } from "./core/types";

export interface CliRoots {
  modRoots: string[];
  referenceRoots: string[];
}

export function resolveRoots(args: string[]): CliRoots {
  const cwd = process.cwd();
  return {
    modRoots: args[0] ? [path.resolve(cwd, args[0])] : [path.resolve(cwd, "../..")],
    referenceRoots: args[1] ? [path.resolve(cwd, args[1])] : [path.resolve(cwd, "../../../game")],
  };
}

export function buildIndexFromArgs(args: string[]): WorkspaceIndex {
  const roots = resolveRoots(args);
  return buildCachedWorkspaceIndex({
    modRoots: roots.modRoots,
    referenceRoots: roots.referenceRoots,
    maxFiles: 20000,
  });
}

export function buildCachedWorkspaceIndex(options: {
  modRoots: string[];
  referenceRoots: string[];
  maxFiles: number;
  trustReferenceCaches?: boolean;
}): WorkspaceIndex {
  const parts = [
    ...options.modRoots.map((root) => loadOrBuildRootIndex(root, "mod", options.maxFiles, options.trustReferenceCaches ?? false)),
    ...options.referenceRoots.map((root) => loadOrBuildRootIndex(root, "reference", options.maxFiles, options.trustReferenceCaches ?? false)),
  ];
  return mergeWorkspaceIndices(parts);
}

export function inspectCachesFromArgs(args: string[]): unknown {
  const roots = resolveRoots(args);
  return inspectCaches({
    modRoots: roots.modRoots,
    referenceRoots: roots.referenceRoots,
    maxFiles: 20000,
  });
}

export function rebuildCachesFromArgs(args: string[]): unknown {
  const roots = resolveRoots(args);
  const options = {
    modRoots: roots.modRoots,
    referenceRoots: roots.referenceRoots,
    maxFiles: 20000,
  };

  for (const entry of cacheTargets(options)) {
    try {
      fs.unlinkSync(entry.cachePath);
    } catch {
      // Ignore missing caches.
    }
  }

  buildCachedWorkspaceIndex(options);
  return inspectCaches(options);
}

export function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function writeError(message: string, code = 1, details?: unknown): never {
  writeJson({
    ok: false,
    error: message,
    details,
  });
  process.exit(code);
}

interface CachedIndexFile {
  version: number;
  manifest: WorkspaceFileRecord[];
  files: string[];
  documents: Array<[string, ParsedDocument]>;
  symbols: Array<[string, unknown]>;
  references: Array<[string, unknown]>;
}

const CACHE_VERSION = 5;

function indexCachePath(input: { root: string; source: "mod" | "reference"; maxFiles: number }): string {
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 12);
  const cacheDir = path.resolve(process.cwd(), ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, `index-${hash}.json`);
}

function readCachedIndex(cachePath: string): CachedIndexFile | null {
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw) as CachedIndexFile;
    if (parsed.version !== CACHE_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedIndex(cachePath: string, payload: CachedIndexFile): void {
  fs.writeFileSync(cachePath, JSON.stringify(payload), "utf8");
}

function manifestsMatch(left: WorkspaceFileRecord[], right: WorkspaceFileRecord[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.path !== b.path ||
      a.source !== b.source ||
      a.size !== b.size ||
      a.mtimeMs !== b.mtimeMs
    ) {
      return false;
    }
  }
  return true;
}

function loadOrBuildRootIndex(
  root: string,
  source: "mod" | "reference",
  maxFiles: number,
  trustReferenceCaches: boolean
): WorkspaceIndex {
  const cachePath = indexCachePath({ root, source, maxFiles });
  const cached = readCachedIndex(cachePath);
  if (source === "reference" && trustReferenceCaches && cached) {
    return hydrateCachedIndex(cached);
  }

  const manifest = collectWorkspaceFiles({
    modRoots: source === "mod" ? [root] : [],
    referenceRoots: source === "reference" ? [root] : [],
    maxFiles,
  });

  if (cached && manifestsMatch(cached.manifest, manifest)) {
    return hydrateCachedIndex(cached);
  }

  const index = createWorkspaceIndexFromCollectedFiles(manifest, {
    includeDocuments: source === "mod",
    includeReferences: source === "mod",
  });
  tryWriteCachedIndex(cachePath, {
    version: CACHE_VERSION,
    manifest,
    files: index.files,
    documents: Array.from(index.documents.entries()),
    symbols: Array.from(index.symbols.entries()),
    references: Array.from(index.references.entries()),
  }, source);
  return index;
}

function tryWriteCachedIndex(cachePath: string, payload: CachedIndexFile, source: "mod" | "reference"): void {
  try {
    writeCachedIndex(cachePath, payload);
  } catch (error) {
    if (source === "reference") {
      return;
    }
    throw error;
  }
}

function hydrateCachedIndex(cached: CachedIndexFile): WorkspaceIndex {
  return {
    documents: new Map(cached.documents),
    symbols: new Map(cached.symbols as [string, WorkspaceIndex["symbols"] extends Map<string, infer V> ? V : never][]),
    references: new Map(cached.references as [string, WorkspaceIndex["references"] extends Map<string, infer V> ? V : never][]),
    files: cached.files,
  };
}

function mergeWorkspaceIndices(parts: WorkspaceIndex[]): WorkspaceIndex {
  const symbols = new Map<string, WorkspaceIndex["symbols"] extends Map<string, infer V> ? V : never>();
  const references = new Map<string, WorkspaceIndex["references"] extends Map<string, infer V> ? V : never>();
  const documents = new Map();
  const files: string[] = [];

  for (const part of parts) {
    files.push(...part.files);

    for (const [filePath, parsed] of part.documents.entries()) {
      documents.set(filePath, parsed);
    }

    for (const [name, entries] of part.symbols.entries()) {
      const existing = symbols.get(name) ?? [];
      symbols.set(name, [...existing, ...entries]);
    }

    for (const [name, entries] of part.references.entries()) {
      const existing = references.get(name) ?? [];
      references.set(name, [...existing, ...entries]);
    }
  }

  return { symbols, references, documents, files };
}

function inspectCaches(options: { modRoots: string[]; referenceRoots: string[]; maxFiles: number }): unknown {
  return {
    ok: true,
    cacheVersion: CACHE_VERSION,
    caches: cacheTargets(options).map((entry) => {
      const cached = readCachedIndex(entry.cachePath);
      return {
        root: entry.root,
        source: entry.source,
        cachePath: entry.cachePath,
        exists: Boolean(cached),
        manifestFiles: cached?.manifest.length ?? 0,
        indexedFiles: cached?.files.length ?? 0,
      };
    }),
  };
}

function cacheTargets(options: { modRoots: string[]; referenceRoots: string[]; maxFiles: number }) {
  return [
    ...options.modRoots.map((root) => ({
      root,
      source: "mod" as const,
      cachePath: indexCachePath({ root, source: "mod", maxFiles: options.maxFiles }),
    })),
    ...options.referenceRoots.map((root) => ({
      root,
      source: "reference" as const,
      cachePath: indexCachePath({ root, source: "reference", maxFiles: options.maxFiles }),
    })),
  ];
}
