import * as path from "path";
import * as vscode from "vscode";
import { createDocumentIndexRecord, WorkspaceIndex } from "../core/indexer";
import { validateParsedDocumentAgainstIndex } from "../core/references";
import { ParsedDocument, ReferenceRecord, SymbolRecord } from "../core/types";
import { buildCachedWorkspaceIndex } from "../cli-shared";
import { readConfig } from "./config";
import { resolveConfiguredSource } from "./sourceResolution";

interface LiveDocumentRecord {
  parsed: ParsedDocument;
  symbols: SymbolRecord[];
  references: ReferenceRecord[];
}

export class IndexStore {
  private index: WorkspaceIndex | null = null;
  private liveDocuments = new Map<string, LiveDocumentRecord>();

  async rebuild(): Promise<void> {
    const config = readConfig();
    this.index = buildCachedWorkspaceIndex(config);
  }

  async ensure(): Promise<WorkspaceIndex> {
    if (!this.index) {
      await this.rebuild();
    }
    return this.index!;
  }

  async snapshot(): Promise<WorkspaceIndex> {
    return this.ensure();
  }

  async symbolsByName(name: string): Promise<SymbolRecord[]> {
    const index = await this.ensure();
    return this.mergedRecordsByName(name, index.symbols, (record) => record.symbols);
  }

  async allSymbols(query?: string): Promise<SymbolRecord[]> {
    const index = await this.ensure();
    const symbols = this.mergedAllRecords(index.symbols, (record) => record.symbols);
    if (!query) {
      return symbols;
    }
    const lowered = query.toLowerCase();
    return symbols.filter((symbol) => symbol.name.toLowerCase().includes(lowered));
  }

  async completionSymbols(kinds: string[], query = "", limit = 100): Promise<SymbolRecord[]> {
    const lowered = query.toLowerCase();
    const matches: SymbolRecord[] = [];
    const grouped = new Map<string, SymbolRecord[]>();

    for (const symbol of await this.allSymbols()) {
      const existing = grouped.get(symbol.name) ?? [];
      existing.push(symbol);
      grouped.set(symbol.name, existing);
    }

    for (const records of grouped.values()) {
      const relevant = records
        .filter((symbol) => symbolMatchesCompletionKinds(symbol.kind, kinds))
        .sort((left, right) => Number(right.source === "mod") - Number(left.source === "mod"));
      if (relevant.length === 0) {
        continue;
      }

      const candidate = relevant[0];
      if (lowered && !candidate.name.toLowerCase().includes(lowered)) {
        continue;
      }
      matches.push(candidate);
    }

    matches.sort((left, right) => {
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      const leftStarts = lowered ? leftName.startsWith(lowered) : false;
      const rightStarts = lowered ? rightName.startsWith(lowered) : false;
      if (leftStarts !== rightStarts) {
        return Number(rightStarts) - Number(leftStarts);
      }
      if (left.source !== right.source) {
        return Number(right.source === "mod") - Number(left.source === "mod");
      }
      return left.name.localeCompare(right.name);
    });

    return matches.slice(0, limit);
  }

  async referencesByName(name: string): Promise<ReferenceRecord[]> {
    const index = await this.ensure();
    return this.mergedRecordsByName(name, index.references, (record) => record.references);
  }

  async validateParsedDocument(parsed: ParsedDocument, filePath = "<in-memory>", source: "mod" | "reference" = "mod") {
    const index = await this.ensure();
    const symbols = this.overlayedSymbols(index, filePath, extractSymbolsForValidation(filePath, parsed, source));
    return validateParsedDocumentAgainstIndex(parsed, {
      ...index,
      symbols,
    });
  }

  syncTextDocument(document: vscode.TextDocument): void {
    if (!matchesCk3Path(document.fileName)) {
      this.liveDocuments.delete(path.resolve(document.fileName));
      return;
    }

    const source = resolveConfiguredSource(document.uri.fsPath, readConfig());
    if (!source) {
      this.liveDocuments.delete(path.resolve(document.fileName));
      return;
    }

    const resolved = path.resolve(document.uri.fsPath);
    this.liveDocuments.set(resolved, createDocumentIndexRecord(resolved, document.getText(), source));
  }

  removeDocument(uri: vscode.Uri): void {
    this.liveDocuments.delete(path.resolve(uri.fsPath));
  }

  async refreshFor(uri: vscode.Uri): Promise<void> {
    const target = path.resolve(uri.fsPath);
    const config = readConfig();
    const insideKnownRoot = [...config.modRoots, ...config.referenceRoots].some((root) => target.startsWith(path.resolve(root)));
    if (!insideKnownRoot) {
      return;
    }
    await this.rebuild();
  }

  private mergedRecordsByName<T extends SymbolRecord | ReferenceRecord>(
    name: string,
    baseMap: Map<string, T[]>,
    pickLive: (record: LiveDocumentRecord) => T[]
  ): T[] {
    const livePaths = new Set(this.liveDocuments.keys());
    const base = (baseMap.get(name) ?? []).filter((entry) => !livePaths.has(path.resolve(entry.path)));
    const live = Array.from(this.liveDocuments.values())
      .flatMap((record) => pickLive(record))
      .filter((entry) => entry.name === name);
    return [...base, ...live];
  }

  private mergedAllRecords<T extends SymbolRecord | ReferenceRecord>(
    baseMap: Map<string, T[]>,
    pickLive: (record: LiveDocumentRecord) => T[]
  ): T[] {
    const livePaths = new Set(this.liveDocuments.keys());
    const base = Array.from(baseMap.values())
      .flat()
      .filter((entry) => !livePaths.has(path.resolve(entry.path)));
    const live = Array.from(this.liveDocuments.values()).flatMap((record) => pickLive(record));
    return [...base, ...live];
  }

  private overlayedSymbols(index: WorkspaceIndex, filePath: string, symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
    const overlayPath = path.resolve(filePath);
    const livePaths = new Set(this.liveDocuments.keys());
    livePaths.add(overlayPath);
    const merged = new Map<string, SymbolRecord[]>();

    for (const [name, entries] of index.symbols.entries()) {
      const filtered = entries.filter((entry) => !livePaths.has(path.resolve(entry.path)));
      if (filtered.length > 0) {
        merged.set(name, filtered);
      }
    }

    for (const record of this.liveDocuments.values()) {
      for (const entry of record.symbols) {
        const existing = merged.get(entry.name) ?? [];
        existing.push(entry);
        merged.set(entry.name, existing);
      }
    }

    for (const entry of symbols) {
      const existing = merged.get(entry.name) ?? [];
      existing.push(entry);
      merged.set(entry.name, existing);
    }

    return merged;
  }
}

function symbolMatchesCompletionKinds(symbolKind: string, completionKinds: string[]): boolean {
  return completionKinds.some((kind) => {
    if (kind === "character_modifier" || kind === "county_modifier" || kind === "province_modifier" || kind === "artifact_modifier") {
      return symbolKind === "modifier";
    }
    return symbolKind === kind;
  });
}

function extractSymbolsForValidation(filePath: string, parsed: ParsedDocument, source: "mod" | "reference"): SymbolRecord[] {
  return createDocumentIndexRecord(filePath, parsed.text, source).symbols;
}

function matchesCk3Path(fileName: string): boolean {
  return /\.(txt|gui|info|asset|yml)$/i.test(fileName);
}
