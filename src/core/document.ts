import * as fs from "fs";
import * as path from "path";
import { parseLocalization } from "./localization";
import { parseScript } from "./parser";
import { ParsedDocument } from "./types";

export function parseDocumentFile(filePath: string): ParsedDocument {
  const resolved = path.resolve(filePath);
  const text = fs.readFileSync(resolved, "utf8");
  return parseDocumentText(resolved, text);
}

export function parseDocumentText(filePath: string, text: string): ParsedDocument {
  if (isLocalizationFile(filePath)) {
    return parseLocalization(text);
  }
  return parseScript(text);
}

export function isLocalizationFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".yml");
}
