import { collectDocumentDiagnostics, DiagnosticRecord } from "./diagnostics";
import { parseDocumentFile } from "./document";
import { WorkspaceIndex } from "./indexer";
import { AssignmentNode, ParsedDocument, ReferenceRecord, SymbolRecord, ValueNode } from "./types";

export interface ReferenceValidationRecord extends DiagnosticRecord {
  name: string;
  referenceKind: string;
}

export interface ReferenceValidationOptions {
  checkpoint?: () => void;
}

export function findReferences(index: WorkspaceIndex, name: string): ReferenceRecord[] {
  return index.references.get(name) ?? [];
}

export function validateReferences(index: WorkspaceIndex, filePath?: string): ReferenceValidationRecord[] {
  const diagnostics: ReferenceValidationRecord[] = [];
  const seen = new Set<string>();

  for (const reference of collectReferences(index, filePath)) {
    if (hasMatchingDefinition(index, reference)) {
      continue;
    }
    const key = diagnosticKey(reference);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    diagnostics.push({
      severity: "warning",
      message: `Unresolved ${reference.kind} reference: ${reference.name}`,
      range: reference.range,
      name: reference.name,
      referenceKind: reference.kind,
    });
  }

  return diagnostics;
}

export function validateParsedDocumentAgainstIndex(
  parsed: ParsedDocument,
  index: WorkspaceIndex,
  options?: ReferenceValidationOptions,
): ReferenceValidationRecord[] {
  return validateParsedReferencesAgainstIndex(parsed, collectParsedReferences(parsed), index, options);
}

export function validateParsedReferencesAgainstIndex(
  parsed: ParsedDocument,
  references: ReferenceRecord[],
  index: WorkspaceIndex,
  options?: ReferenceValidationOptions,
): ReferenceValidationRecord[] {
  const diagnostics: ReferenceValidationRecord[] = [];
  const seen = new Set<string>();
  for (const diagnostic of collectDocumentDiagnostics(parsed)) {
    diagnostics.push({
      ...diagnostic,
      name: "",
      referenceKind: "syntax",
    });
  }

  for (let indexRef = 0; indexRef < references.length; indexRef += 1) {
    if (indexRef % 128 === 0) {
      options?.checkpoint?.();
    }
    const reference = references[indexRef];
    if (hasMatchingDefinition(index, reference)) {
      continue;
    }
    const key = diagnosticKey(reference);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    diagnostics.push({
      severity: "warning",
      message: `Unresolved ${reference.kind} reference: ${reference.name}`,
      range: reference.range,
      name: reference.name,
      referenceKind: reference.kind,
    });
  }

  return diagnostics;
}

export function collectParsedReferences(parsed: ParsedDocument): ReferenceRecord[] {
  return extractReferencesFromParsedDocument(parsed);
}

function* collectReferences(index: WorkspaceIndex, filePath?: string): Iterable<ReferenceRecord> {
  for (const entries of index.references.values()) {
    for (const reference of entries) {
      if (reference.source !== "mod") {
        continue;
      }
      if (filePath && reference.path !== filePath) {
        continue;
      }
      yield reference;
    }
  }
}

function hasMatchingDefinition(index: WorkspaceIndex, reference: ReferenceRecord): boolean {
  const definitions = index.symbols.get(reference.name) ?? [];
  return definitions.some((definition) => symbolMatchesReference(definition, reference));
}

function symbolMatchesReference(symbol: SymbolRecord, reference: ReferenceRecord): boolean {
  if (symbol.kind === "localization-reference") {
    return false;
  }
  if (reference.kind === "event") {
    return symbol.kind === "event" || symbol.kind === "event-like" || symbol.kind === "definition";
  }
  if (reference.kind === "faith") {
    return symbol.kind === "faith" || symbol.kind === "religion" || symbol.kind === "definition";
  }
  if (reference.kind === "doctrine") {
    return symbol.kind === "doctrine" || symbol.kind === "definition";
  }
  if (reference.kind === "doctrine_parameter") {
    return symbol.kind === "doctrine_parameter" || symbol.kind === "definition";
  }
  if (reference.kind === "scripted_effect" || reference.kind === "scripted_trigger") {
    return symbol.kind === reference.kind || symbol.kind === "definition";
  }
  if (
    reference.kind === "modifier" ||
    reference.kind === "character_modifier" ||
    reference.kind === "county_modifier" ||
    reference.kind === "province_modifier" ||
    reference.kind === "artifact_modifier"
  ) {
    return symbol.kind === "modifier" || symbol.kind === "definition";
  }
  return symbol.kind === reference.kind || (reference.kind === "localization" && symbol.kind === "localization");
}

function extractReferencesFromParsedDocument(parsed: ParsedDocument): ReferenceRecord[] {
  const path = "<in-memory>";
  if (parsed.kind === "localization") {
    return [];
  }

  const references: ReferenceRecord[] = [];
  const entries = parsed.entries;

  const walk = (nestedEntries: AssignmentNode[], depth = 0, parents: string[] = []) => {
    for (const entry of nestedEntries) {
      const scalar = entry.value.kind === "object" || entry.value.kind === "list" ? null : entry.value.value;
      const keyPrefixedReference = prefixedReference(entry.key, entry.keyRange);
      if (keyPrefixedReference) {
        references.push({ ...keyPrefixedReference, path, source: "mod" });
      }

      if (isLocalizationReferenceEntry(entry.key, scalar, parents)) {
        references.push({ name: scalar, kind: "localization", path, range: entry.value.range, source: "mod" });
      }
      if ((entry.key === "trigger_event" || entry.key === "triggered_event") && scalar) {
        references.push({ name: scalar, kind: "event", path, range: entry.value.range, source: "mod" });
      }
      if ((entry.key === "trigger_event" || entry.key === "triggered_event") && entry.value.kind === "object") {
        for (const nested of entry.value.entries) {
          if (nested.key !== "id" || nested.value.kind === "object" || nested.value.kind === "list") {
            continue;
          }
          references.push({ name: nested.value.value, kind: "event", path, range: nested.value.range, source: "mod" });
        }
      }
      if (scalar && entry.key === "modifier") {
        references.push({ name: scalar, kind: resolveModifierReferenceKind(entry.key, parents), path, range: entry.value.range, source: "mod" });
      }
      if (scalar && TRAIT_REFERENCE_KEYS.has(entry.key)) {
        references.push({ name: scalar, kind: "trait", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && MODIFIER_REFERENCE_KEYS.has(entry.key)) {
        references.push({ name: scalar, kind: resolveModifierReferenceKind(entry.key, parents), path, range: entry.value.range, source: "mod" });
      }
      if (scalar && CULTURE_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
        references.push({ name: scalar, kind: "culture", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && FAITH_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
        references.push({ name: scalar, kind: "faith", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && CULTURAL_TRADITION_REFERENCE_KEYS.has(entry.key)) {
        references.push({ name: scalar, kind: "cultural_tradition", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && CULTURAL_PILLAR_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
        references.push({ name: scalar, kind: "cultural_pillar", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && DOCTRINE_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
        references.push({ name: scalar, kind: "doctrine", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && DOCTRINE_PARAMETER_REFERENCE_KEYS.has(entry.key) && shouldTreatAsStaticValueReference(scalar)) {
        references.push({ name: scalar, kind: "doctrine_parameter", path, range: entry.value.range, source: "mod" });
      }
      if (scalar) {
        const scalarPrefixedReference = prefixedReference(scalar, entry.value.range);
        if (scalarPrefixedReference) {
          references.push({ ...scalarPrefixedReference, path, source: "mod" });
        }
      }
      if (entry.key === "traditions") {
        for (const value of scalarValues(entry.value)) {
          references.push({ name: value.name, kind: "cultural_tradition", path, range: value.range, source: "mod" });
        }
      }
      if (scalar && entry.key === "type" && parents[parents.length - 1] === "create_artifact") {
        references.push({ name: scalar, kind: "artifact_type", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && entry.key === "visuals" && parents[parents.length - 1] === "create_artifact") {
        references.push({ name: scalar, kind: "artifact_visual", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && entry.key === "template" && parents[parents.length - 1] === "create_artifact") {
        references.push({ name: scalar, kind: "artifact_template", path, range: entry.value.range, source: "mod" });
      }
      if (scalar && depth > 0 && entry.key.endsWith("_effect") && !entry.key.startsWith("add_") && !entry.key.startsWith("remove_")) {
        references.push({ name: entry.key, kind: "scripted_effect", path, range: entry.keyRange, source: "mod" });
      }
      if (scalar && depth > 0 && entry.key.endsWith("_trigger") && !entry.key.startsWith("has_")) {
        references.push({ name: entry.key, kind: "scripted_trigger", path, range: entry.keyRange, source: "mod" });
      }
      if (entry.value.kind === "object") {
        walk(entry.value.entries, depth + 1, [...parents, entry.key]);
      }
    }
  };

  walk(entries);
  return references;
}

export function validateDocumentFileAgainstIndex(index: WorkspaceIndex, filePath: string): ReferenceValidationRecord[] {
  const parsed = parseDocumentFile(filePath);
  return validateParsedDocumentAgainstIndex(parsed, index);
}

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

function scalarValues(node: ValueNode): Array<{ name: string; range: ReferenceRecord["range"] }> {
  if (node.kind === "object") {
    return [];
  }
  if (node.kind === "list") {
    return node.items.flatMap((item) => scalarValues(item));
  }
  return [{ name: node.value, range: node.range }];
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

function diagnosticKey(reference: ReferenceRecord): string {
  return [
    reference.name,
    reference.kind,
    reference.path,
    reference.range.start.line,
    reference.range.start.character,
  ].join(":");
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
