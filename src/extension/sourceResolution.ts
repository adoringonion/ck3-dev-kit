import * as path from "path";

export interface SourceRoots {
  modRoots: string[];
  referenceRoots: string[];
}

export function resolveConfiguredSource(filePath: string, config: SourceRoots): "mod" | "reference" | null {
  const target = path.resolve(filePath);
  if (config.modRoots.some((root) => target.startsWith(path.resolve(root)))) {
    return "mod";
  }
  if (config.referenceRoots.some((root) => target.startsWith(path.resolve(root)))) {
    return "reference";
  }
  return null;
}
