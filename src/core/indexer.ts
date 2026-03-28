import * as fs from "fs";
import * as path from "path";
import { parseDocumentText } from "./document";
import { flattenEntries, parseScript, scalarValue } from "./parser";
import { parseLocalization } from "./localization";
import { AssignmentNode, ParsedDocument, ReferenceRecord, SymbolRecord, ValueNode } from "./types";

const SCRIPT_EXTENSIONS = new Set([".txt", ".gui", ".info", ".asset"]);
const LOCALIZATION_EXTENSIONS = new Set([".yml"]);
const CK3_DIR_HINTS = new Set([
  "common",
  "artifacts",
  "culture",
  "cultures",
  "dlc",
  "events",
  "history",
  "gui",
  "localization",
  "opinion_modifiers",
  "pillars",
  "templates",
  "religion",
  "doctrines",
  "religions",
  "traditions",
  "types",
  "visuals",
  "map_data",
  "notifications",
  "data_binding",
  "gfx"
]);
const TRAIT_REFERENCE_KEYS = new Set(["has_trait", "add_trait", "remove_trait"]);
const MODIFIER_REFERENCE_KEYS = new Set([
  "modifier",
  "has_character_modifier",
  "remove_character_modifier",
  "has_county_modifier",
  "remove_county_modifier",
  "has_province_modifier",
  "remove_province_modifier",
]);
const CULTURE_REFERENCE_KEYS = new Set(["culture"]);
const FAITH_REFERENCE_KEYS = new Set(["faith"]);
const CULTURAL_TRADITION_REFERENCE_KEYS = new Set(["has_cultural_tradition"]);
const CULTURAL_PILLAR_REFERENCE_KEYS = new Set(["has_cultural_pillar", "ethos", "heritage", "language", "martial_custom"]);
const DOCTRINE_REFERENCE_KEYS = new Set(["has_doctrine", "doctrine"]);
const DOCTRINE_PARAMETER_REFERENCE_KEYS = new Set(["has_doctrine_parameter"]);

export interface IndexOptions {
  modRoots: string[];
  referenceRoots: string[];
  maxFiles?: number;
}

export interface WorkspaceIndex {
  symbols: Map<string, SymbolRecord[]>;
  references: Map<string, ReferenceRecord[]>;
  documents: Map<string, ParsedDocument>;
  files: string[];
}

export interface WorkspaceFileRecord {
  path: string;
  source: "mod" | "reference";
  mtimeMs: number;
  size: number;
}

export interface CreateWorkspaceIndexOptions {
  includeDocuments?: boolean;
  includeReferences?: boolean;
}

export function createWorkspaceIndex(options: IndexOptions): WorkspaceIndex {
  return createWorkspaceIndexFromCollectedFiles(collectWorkspaceFiles(options));
}

export function collectWorkspaceFiles(options: IndexOptions): WorkspaceFileRecord[] {
  const files: WorkspaceFileRecord[] = [];
  const maxFiles = options.maxFiles ?? 20000;

  const roots: Array<{ root: string; source: "mod" | "reference" }> = [
    ...options.modRoots.map((root) => ({ root, source: "mod" as const })),
    ...options.referenceRoots.map((root) => ({ root, source: "reference" as const })),
  ];

  for (const { root, source } of roots) {
    for (const file of walkCk3Files(root, maxFiles - files.length)) {
      if (files.length >= maxFiles) {
        break;
      }
      const stat = safeStat(file);
      if (!stat || !stat.isFile()) {
        continue;
      }
      files.push({
        path: file,
        source,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

export function createWorkspaceIndexFromCollectedFiles(
  collectedFiles: WorkspaceFileRecord[],
  options: CreateWorkspaceIndexOptions = {}
): WorkspaceIndex {
  const symbols = new Map<string, SymbolRecord[]>();
  const references = new Map<string, ReferenceRecord[]>();
  const documents = new Map<string, ParsedDocument>();
  const files: string[] = [];
  const includeDocuments = options.includeDocuments ?? true;
  const includeReferences = options.includeReferences ?? true;

  for (const record of collectedFiles) {
    files.push(record.path);
    const text = safeReadFile(record.path);
    if (text === null) {
      continue;
    }

    const parsed = parseDocumentText(record.path, text);
    if (includeDocuments) {
      documents.set(record.path, parsed);
    }

    for (const symbol of extractSymbols(record.path, parsed, record.source)) {
      const existing = symbols.get(symbol.name) ?? [];
      existing.push(symbol);
      symbols.set(symbol.name, existing);
    }

    if (includeReferences) {
      for (const reference of extractReferences(record.path, parsed, record.source)) {
        const existing = references.get(reference.name) ?? [];
        existing.push(reference);
        references.set(reference.name, existing);
      }
    }
  }

  return { symbols, references, documents, files };
}

export function createDocumentIndexRecord(filePath: string, text: string, source: "mod" | "reference") {
  const parsed = parseDocumentText(filePath, text);
  return {
    parsed,
    symbols: extractSymbols(filePath, parsed, source),
    references: extractReferences(filePath, parsed, source),
  };
}

function walkCk3Files(root: string, budget: number): string[] {
  const resolved = path.resolve(root);
  if (!fs.existsSync(resolved)) {
    return [];
  }

  const queue = [resolved];
  const results: string[] = [];

  while (queue.length > 0 && results.length < budget) {
    const current = queue.shift()!;
    const stat = safeStat(current);
    if (!stat) {
      continue;
    }

    if (stat.isDirectory()) {
      const basename = path.basename(current);
      const parent = path.basename(path.dirname(current));
      const isDirectChildOfRoot = path.dirname(current) === resolved;
      const looksLikeModRoot = fs.existsSync(path.join(current, "descriptor.mod"));
      const insideKnownContentTree = hasContentAncestor(current, resolved);
      if (
        current !== resolved &&
        !isDirectChildOfRoot &&
        !looksLikeModRoot &&
        !insideKnownContentTree &&
        !CK3_DIR_HINTS.has(basename) &&
        !CK3_DIR_HINTS.has(parent)
      ) {
        continue;
      }

      for (const entry of safeReadDir(current)) {
        queue.push(path.join(current, entry));
      }
      continue;
    }

    const extension = path.extname(current).toLowerCase();
    if (SCRIPT_EXTENSIONS.has(extension) || LOCALIZATION_EXTENSIONS.has(extension)) {
      results.push(current);
    }
  }

  return results;
}

function extractSymbols(file: string, parsed: ParsedDocument, source: "mod" | "reference"): SymbolRecord[] {
  if (parsed.kind === "localization") {
    return parsed.entries.map((entry) => ({
      name: entry.key,
      kind: "localization",
      path: file,
      range: entry.range,
      source,
    }));
  }

  const symbols: SymbolRecord[] = [];
  const topLevel = parsed.entries;
  const folderKind = inferFolderKind(file);
  const namespaceAssignment = topLevel.find((entry) => entry.key === "namespace");
  if (namespaceAssignment) {
    const value = scalarValue(namespaceAssignment.value);
    if (value) {
      symbols.push({
        name: value,
        kind: "namespace",
        path: file,
        range: namespaceAssignment.value.range,
        source,
      });
    }
  }

  if (folderKind === "doctrines") {
    for (const group of topLevel) {
      if (group.value.kind !== "object") {
        continue;
      }
      for (const doctrine of group.value.entries) {
        if (doctrine.value.kind !== "object") {
          continue;
        }
        symbols.push({
          name: doctrine.key,
          kind: "doctrine",
          path: file,
          range: doctrine.keyRange,
          containerName: group.key,
          source,
        });

        const parametersEntry = doctrine.value.entries.find((entry) => entry.key === "parameters" && entry.value.kind === "object");
        if (parametersEntry && parametersEntry.value.kind === "object") {
          for (const parameter of parametersEntry.value.entries) {
            symbols.push({
              name: parameter.key,
              kind: "doctrine_parameter",
              path: file,
              range: parameter.keyRange,
              containerName: doctrine.key,
              source,
            });
          }
        }
      }
    }
  }

  if (folderKind === "religions") {
    for (const religion of topLevel) {
      if (religion.value.kind !== "object") {
        continue;
      }
      const faithsEntry = religion.value.entries.find((entry) => entry.key === "faiths" && entry.value.kind === "object");
      if (!faithsEntry || faithsEntry.value.kind !== "object") {
        continue;
      }
      for (const faith of faithsEntry.value.entries) {
        if (faith.value.kind !== "object") {
          continue;
        }
        symbols.push({
          name: faith.key,
          kind: "faith",
          path: file,
          range: faith.keyRange,
          containerName: religion.key,
          source,
        });
      }
    }
  }

  for (const entry of topLevel) {
    const value = entry.value;
    if (entry.key === "namespace") {
      continue;
    }
    if (value.kind !== "object" && !supportsScalarDefinitions(folderKind)) {
      continue;
    }

    const kind = inferSymbolKind(folderKind, entry, namespaceAssignment ? scalarValue(namespaceAssignment.value) : null);
    if (!kind) {
      continue;
    }

    symbols.push({
      name: entry.key,
      kind,
      path: file,
      range: entry.keyRange,
      containerName: folderKind ?? undefined,
      source,
    });
  }

  if (folderKind === "scripted_effects" || folderKind === "scripted_triggers") {
    return symbols;
  }

  walkEntries(topLevel, (entry, _depth, parents) => {
    const value = scalarValue(entry.value);
    if (!isLocalizationReferenceEntry(entry.key, value, parents)) {
      return;
    }
    symbols.push({
      name: value!,
      kind: "localization-reference",
      path: file,
      range: entry.value.range,
      source,
    });
  });

  return symbols;
}

function extractReferences(file: string, parsed: ParsedDocument, source: "mod" | "reference"): ReferenceRecord[] {
  if (parsed.kind === "localization") {
    return [];
  }

  const references: ReferenceRecord[] = [];
  const folderKind = inferFolderKind(file);

  walkEntries(parsed.entries, (entry, depth, parents) => {
    const scalar = scalarValue(entry.value);
    const keyPrefixedReference = prefixedReference(entry.key, entry.keyRange);
    if (keyPrefixedReference) {
      references.push({
        ...keyPrefixedReference,
        path: file,
        source,
      });
    }

    if (isLocalizationReferenceEntry(entry.key, scalar, parents)) {
      references.push({
        name: scalar,
        kind: "localization",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if ((entry.key === "trigger_event" || entry.key === "triggered_event") && scalar) {
      references.push({
        name: scalar,
        kind: "event",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if ((entry.key === "trigger_event" || entry.key === "triggered_event") && entry.value.kind === "object") {
      for (const nested of entry.value.entries) {
        if (nested.key !== "id") {
          continue;
        }
        const eventId = scalarValue(nested.value);
        if (!eventId) {
          continue;
        }
        references.push({
          name: eventId,
          kind: "event",
          path: file,
          range: nested.value.range,
          source,
        });
      }
    }

    if (scalar && entry.key === "modifier") {
      references.push({
        name: scalar,
        kind: resolveModifierReferenceKind(entry.key, parents),
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && TRAIT_REFERENCE_KEYS.has(entry.key)) {
      references.push({
        name: scalar,
        kind: "trait",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && MODIFIER_REFERENCE_KEYS.has(entry.key)) {
      references.push({
        name: scalar,
        kind: resolveModifierReferenceKind(entry.key, parents),
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && CULTURE_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
      references.push({
        name: scalar,
        kind: "culture",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && FAITH_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
      references.push({
        name: scalar,
        kind: "faith",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && CULTURAL_TRADITION_REFERENCE_KEYS.has(entry.key)) {
      references.push({
        name: scalar,
        kind: "cultural_tradition",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && CULTURAL_PILLAR_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
      references.push({
        name: scalar,
        kind: "cultural_pillar",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && DOCTRINE_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
      references.push({
        name: scalar,
        kind: "doctrine",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && DOCTRINE_PARAMETER_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
      references.push({
        name: scalar,
        kind: "doctrine_parameter",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar) {
      const scalarPrefixedReference = prefixedReference(scalar, entry.value.range);
      if (scalarPrefixedReference) {
        references.push({
          ...scalarPrefixedReference,
          path: file,
          source,
        });
      }
    }

    if (entry.key === "traditions") {
      for (const value of scalarValues(entry.value)) {
        references.push({
          name: value.name,
          kind: "cultural_tradition",
          path: file,
          range: value.range,
          source,
        });
      }
    }

    if (scalar && entry.key === "type" && parents[parents.length - 1] === "create_artifact") {
      references.push({
        name: scalar,
        kind: "artifact_type",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && entry.key === "visuals" && parents[parents.length - 1] === "create_artifact") {
      references.push({
        name: scalar,
        kind: "artifact_visual",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && entry.key === "template" && parents[parents.length - 1] === "create_artifact") {
      references.push({
        name: scalar,
        kind: "artifact_template",
        path: file,
        range: entry.value.range,
        source,
      });
    }

    if (scalar && depth > 0 && folderKind !== "scripted_effects" && looksLikeScriptedEffectReference(entry.key)) {
      references.push({
        name: entry.key,
        kind: "scripted_effect",
        path: file,
        range: entry.keyRange,
        source,
      });
    }

    if (scalar && depth > 0 && folderKind !== "scripted_triggers" && looksLikeScriptedTriggerReference(entry.key)) {
      references.push({
        name: entry.key,
        kind: "scripted_trigger",
        path: file,
        range: entry.keyRange,
        source,
      });
    }
  });

  return references;
}

function walkEntries(entries: AssignmentNode[], visit: (entry: AssignmentNode, depth: number, parents: string[]) => void, depth = 0, parents: string[] = []): void {
  for (const entry of entries) {
    visit(entry, depth, parents);
    if (entry.value.kind === "object") {
      walkEntries(entry.value.entries, visit, depth + 1, [...parents, entry.key]);
    }
  }
}

function inferFolderKind(file: string): string | null {
  const normalized = file.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (matchesPath(parts, ["common", "traits"])) {
    return "traits";
  }
  if (matchesPath(parts, ["common", "opinion_modifiers"])) {
    return "modifiers";
  }
  if (matchesPath(parts, ["common", "culture", "cultures"])) {
    return "cultures";
  }
  if (matchesPath(parts, ["common", "artifacts", "types"])) {
    return "artifact_types";
  }
  if (matchesPath(parts, ["common", "artifacts", "templates"])) {
    return "artifact_templates";
  }
  if (matchesPath(parts, ["common", "artifacts", "visuals"])) {
    return "artifact_visuals";
  }
  if (matchesPath(parts, ["common", "culture", "traditions"])) {
    return "traditions";
  }
  if (matchesPath(parts, ["common", "culture", "pillars"])) {
    return "pillars";
  }
  if (matchesPath(parts, ["common", "religion", "religions"])) {
    return "religions";
  }
  if (matchesPath(parts, ["common", "religion", "doctrines"])) {
    return "doctrines";
  }
  if (matchesPath(parts, ["common", "script_values"])) {
    return "script_values";
  }
  if (parts.includes("events")) {
    return "events";
  }
  if (parts.includes("history")) {
    return "history";
  }
  if (parts.includes("localization")) {
    return "localization";
  }
  const commonIndex = findContentDirIndex(parts, "common");
  if (commonIndex >= 0 && commonIndex + 1 < parts.length) {
    return parts[commonIndex + 1];
  }
  return null;
}

function matchesPath(parts: string[], sequence: string[]): boolean {
  for (let index = 0; index <= parts.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (parts[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

function hasContentAncestor(current: string, root: string): boolean {
  const relative = path.relative(root, current).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..")) {
    return false;
  }
  const parts = relative.split("/");
  return parts.some((part) => CK3_DIR_HINTS.has(part));
}

function findContentDirIndex(parts: string[], target: string): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] === target) {
      return index;
    }
  }
  return -1;
}

function inferSymbolKind(folderKind: string | null, entry: AssignmentNode, namespaceValue: string | null): string | null {
  if (folderKind === "events") {
    if (namespaceValue && entry.key.startsWith(`${namespaceValue}.`)) {
      return "event";
    }
    return "event-like";
  }
  if (folderKind === "scripted_effects") {
    return "scripted_effect";
  }
  if (folderKind === "scripted_triggers") {
    return "scripted_trigger";
  }
  if (folderKind === "decisions") {
    return "decision";
  }
  if (folderKind === "casus_belli_types") {
    return "casus_belli";
  }
  if (folderKind === "modifiers") {
    return "modifier";
  }
  if (folderKind === "traits") {
    return "trait";
  }
  if (folderKind === "artifact_types") {
    return "artifact_type";
  }
  if (folderKind === "artifact_templates") {
    return "artifact_template";
  }
  if (folderKind === "artifact_visuals") {
    return "artifact_visual";
  }
  if (folderKind === "cultures") {
    return "culture";
  }
  if (folderKind === "religions") {
    return "religion";
  }
  if (folderKind === "traditions") {
    return "cultural_tradition";
  }
  if (folderKind === "pillars") {
    return "cultural_pillar";
  }
  if (folderKind === "script_values") {
    return "script_value";
  }
  return "definition";
}

function supportsScalarDefinitions(folderKind: string | null): boolean {
  return folderKind === "script_values";
}

function scalarValues(node: ValueNode): Array<{ name: string; range: ReferenceRecord["range"] }> {
  if (node.kind === "object") {
    return [];
  }
  if (node.kind === "list") {
    return node.items.flatMap((item) => scalarValues(item));
  }
  return [{ name: node.value, range: node.range }];
}

function isLocalizationReferenceEntry(key: string, value: string | null, parents: string[]): value is string {
  if (!value) {
    return false;
  }
  if (key === "title" || key === "desc") {
    return true;
  }
  if (key !== "name") {
    return false;
  }
  const currentParent = parents[parents.length - 1] ?? "";
  return currentParent === "option" && looksLikeLocalizationKey(value);
}

function looksLikeLocalizationKey(value: string): boolean {
  return value.includes(".") && /^[\w.-]+$/.test(value);
}

function resolveModifierReferenceKind(key: string, parents: string[]): string {
  const current = parents[parents.length - 1] ?? "";

  if (key === "has_character_modifier" || key === "remove_character_modifier" || current === "add_character_modifier") {
    return "character_modifier";
  }
  if (key === "has_county_modifier" || key === "remove_county_modifier" || current === "add_county_modifier") {
    return "county_modifier";
  }
  if (key === "has_province_modifier" || key === "remove_province_modifier" || current === "add_province_modifier") {
    return "province_modifier";
  }
  if (current === "create_artifact") {
    return "artifact_modifier";
  }
  return "modifier";
}

function prefixedReference(value: string, range: ReferenceRecord["range"]): Omit<ReferenceRecord, "path" | "source"> | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }

  const prefix = value.slice(0, separator);
  const name = value.slice(separator + 1);

  let kind: string | null = null;
  switch (prefix) {
    case "doctrine":
      kind = "doctrine";
      break;
    case "culture_tradition":
      kind = "cultural_tradition";
      break;
    case "culture_pillar":
      kind = "cultural_pillar";
      break;
    case "faith":
      kind = "faith";
      break;
    case "artifact":
      kind = "artifact_template";
      break;
    default:
      kind = null;
  }

  if (!kind) {
    return null;
  }

  return { name, kind, range };
}

function shouldTreatAsStaticValueReference(value: string): boolean {
  return !isDynamicValueReference(value);
}

function isDynamicValueReference(value: string): boolean {
  if (value.startsWith("@")) {
    return true;
  }

  if (looksLikeScopedPropertyReference(value)) {
    return true;
  }

  const separator = value.indexOf(":");
  if (separator <= 0) {
    return false;
  }

  const prefix = value.slice(0, separator);
  return DYNAMIC_REFERENCE_PREFIXES.has(prefix);
}

const DYNAMIC_REFERENCE_PREFIXES = new Set([
  "scope",
  "var",
  "local_var",
  "global_var",
  "event_target",
  "named_script_value",
  "named_script_value_item",
]);

const DYNAMIC_SCOPE_PREFIXES = new Set([
  "root",
  "prev",
  "this",
  "owner",
  "holder",
  "liege",
  "top_liege",
  "primary_title",
  "capital_county",
  "culture",
  "faith",
  "title",
  "character",
]);

function looksLikeScopedPropertyReference(value: string): boolean {
  const separator = value.indexOf(".");
  if (separator <= 0) {
    return false;
  }
  return DYNAMIC_SCOPE_PREFIXES.has(value.slice(0, separator));
}

function looksLikeScriptedEffectReference(key: string): boolean {
  return key.endsWith("_effect") && !key.startsWith("add_") && !key.startsWith("remove_");
}

function looksLikeScriptedTriggerReference(key: string): boolean {
  return key.endsWith("_trigger") && !key.startsWith("has_");
}

function safeReadFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function safeReadDir(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function safeStat(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
