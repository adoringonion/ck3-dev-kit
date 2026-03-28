import { ReferenceRecord, SymbolRecord } from "../core/types";

export interface RenameCandidate {
  kind: string;
  source: "mod" | "reference";
}

export interface RenameTarget {
  kind: string;
  definitionKey: string;
}

export function normalizeRenameKind(kind: string): string {
  if (
    kind === "character_modifier" ||
    kind === "county_modifier" ||
    kind === "province_modifier" ||
    kind === "artifact_modifier"
  ) {
    return "modifier";
  }
  return kind;
}

export function renameCompatibleSymbolKind(symbolKind: string, targetKind: string): boolean {
  return normalizeRenameKind(symbolKind) === targetKind;
}

export function renameCompatibleReferenceKind(referenceKind: string, targetKind: string): boolean {
  const normalized = normalizeRenameKind(referenceKind);
  if (targetKind === "religion" && normalized === "faith") {
    return true;
  }
  if (targetKind === "faith" && normalized === "religion") {
    return true;
  }
  return normalized === targetKind;
}

export function resolveModRenameTarget(
  candidate: RenameCandidate | null,
  allSymbols: SymbolRecord[],
): RenameTarget | null {
  if (!candidate || candidate.source !== "mod") {
    return null;
  }

  const compatibleSymbols = allSymbols.filter((symbol) =>
    symbol.source === "mod" && renameCompatibleSymbolKind(symbol.kind, candidate.kind)
  );
  if (compatibleSymbols.length === 0) {
    return null;
  }

  const definitionKeys = new Set(compatibleSymbols.map(symbolDefinitionKey));
  if (definitionKeys.size !== 1) {
    return null;
  }

  return {
    kind: candidate.kind,
    definitionKey: compatibleSymbols.length > 0 ? symbolDefinitionKey(compatibleSymbols[0]) : "",
  };
}

export function filterModRenameSymbols(symbols: SymbolRecord[], target: RenameTarget): SymbolRecord[] {
  return symbols.filter((symbol) =>
    symbol.source === "mod" &&
    renameCompatibleSymbolKind(symbol.kind, target.kind) &&
    symbolDefinitionKey(symbol) === target.definitionKey
  );
}

export function filterModRenameReferences(references: ReferenceRecord[], target: RenameTarget): ReferenceRecord[] {
  return references.filter((reference) =>
    reference.source === "mod" && renameCompatibleReferenceKind(reference.kind, target.kind)
  );
}

function symbolDefinitionKey(symbol: SymbolRecord): string {
  return [
    normalizeRenameKind(symbol.kind),
    symbol.containerName ?? "",
    symbol.path,
  ].join("|");
}
