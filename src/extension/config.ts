import * as os from "os";
import * as path from "path";
import * as fs from "fs";
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
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaceFolder = folders[0]?.uri.fsPath ?? process.cwd();
  if (folders.length === 0) {
    const config = vscode.workspace.getConfiguration("ck3ModDevkit");
    const modRoots = dedupePaths(resolveArray(config.get<string[]>("modRoots", [workspaceFolder]), workspaceFolder));
    const referenceRoots = dedupePaths(resolveArray(config.get<string[]>("referenceRoots", [path.join(workspaceFolder, "../game")]), workspaceFolder));
    const maxFiles = config.get<number>("maxFiles", 20000);
    const errorLogPath = resolveVariables(config.get<string>("errorLogPath", defaultCk3ErrorLogPath()), workspaceFolder);
    return { modRoots, referenceRoots, maxFiles, errorLogPath };
  }

  const modRoots = dedupePaths(folders.flatMap((folder) => {
    const folderPath = folder.uri.fsPath;
    const config = vscode.workspace.getConfiguration("ck3ModDevkit", folder.uri);
    return resolveArray(config.get<string[]>("modRoots", [folderPath]), folderPath);
  }));
  const referenceRoots = dedupePaths(folders.flatMap((folder) => {
    const folderPath = folder.uri.fsPath;
    const config = vscode.workspace.getConfiguration("ck3ModDevkit", folder.uri);
    return resolveArray(
      config.get<string[]>("referenceRoots", discoverDefaultReferenceRoots([folder], folderPath)),
      folderPath
    );
  }));
  const maxFiles = Math.max(...folders.map((folder) => {
    const config = vscode.workspace.getConfiguration("ck3ModDevkit", folder.uri);
    return config.get<number>("maxFiles", 20000);
  }));
  const primaryConfig = vscode.workspace.getConfiguration("ck3ModDevkit", folders[0].uri);
  const errorLogPath = resolveVariables(primaryConfig.get<string>("errorLogPath", defaultCk3ErrorLogPath()), workspaceFolder);

  return { modRoots, referenceRoots, maxFiles, errorLogPath };
}

export function resolveConfiguredSource(filePath: string, config = readConfig()): "mod" | "reference" | null {
  return resolveConfiguredSourceFromRoots(filePath, config);
}

function resolveArray(values: string[], workspaceFolder: string): string[] {
  return values.map((value) => resolveVariables(value, workspaceFolder));
}

function discoverDefaultReferenceRoots(folders: readonly vscode.WorkspaceFolder[], workspaceFolder: string): string[] {
  const candidates = (folders.length > 0 ? folders.map((folder) => path.join(folder.uri.fsPath, "../game")) : [path.join(workspaceFolder, "../game")])
    .map((candidate) => path.resolve(candidate));
  const existing = candidates.filter(looksLikeCk3GameRoot);
  return existing.length > 0 ? dedupePaths(existing) : [path.resolve(path.join(workspaceFolder, "../game"))];
}

function looksLikeCk3GameRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, "common")) || fs.existsSync(path.join(candidate, "events"));
}

function dedupePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function resolveVariables(value: string, workspaceFolder: string): string {
  return path.resolve(
    value
      .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
      .replace(/\$\{userHome\}/g, os.homedir())
  );
}
