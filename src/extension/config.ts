import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { defaultCk3ErrorLogPath } from "../core/errorLog";
import { resolveConfiguredSource as resolveConfiguredSourceFromRoots } from "./sourceResolution";

export interface ResolvedConfig {
  modRoots: string[];
  referenceRoots: string[];
  maxFiles: number;
  errorLogPath: string;
}

export function readConfig(): ResolvedConfig {
  const config = vscode.workspace.getConfiguration("ck3ModDevkit");
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaceFolder = folders[0]?.uri.fsPath ?? process.cwd();

  const modRoots = resolveArray(config.get<string[]>("modRoots", [workspaceFolder]), workspaceFolder);
  const referenceRoots = resolveArray(config.get<string[]>("referenceRoots", [path.join(workspaceFolder, "../game")]), workspaceFolder);
  const maxFiles = config.get<number>("maxFiles", 20000);
  const errorLogPath = resolveVariables(config.get<string>("errorLogPath", defaultCk3ErrorLogPath()), workspaceFolder);

  return { modRoots, referenceRoots, maxFiles, errorLogPath };
}

export function resolveConfiguredSource(filePath: string, config = readConfig()): "mod" | "reference" | null {
  return resolveConfiguredSourceFromRoots(filePath, config);
}

function resolveArray(values: string[], workspaceFolder: string): string[] {
  return values.map((value) => resolveVariables(value, workspaceFolder));
}

function resolveVariables(value: string, workspaceFolder: string): string {
  return path.resolve(
    value
      .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
      .replace(/\$\{userHome\}/g, os.homedir())
  );
}
