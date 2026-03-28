import * as vscode from "vscode";

export async function writeWorkspaceAssociations(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage("Open your mod workspace before writing CK3 file associations.");
    return;
  }

  const config = vscode.workspace.getConfiguration("files");
  const existing = config.get<Record<string, string>>("associations", {});
  const merged: Record<string, string> = {
    ...existing,
    "**/common/**/*.txt": "ck3-script",
    "**/events/**/*.txt": "ck3-script",
    "**/history/**/*.txt": "ck3-script",
    "**/data_binding/**/*.txt": "ck3-script",
    "**/notifications/**/*.txt": "ck3-script",
    "**/*.gui": "ck3-script",
    "**/*.info": "ck3-script",
    "**/localization/**/*.yml": "ck3-localization",
  };

  await config.update("associations", merged, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage("CK3 workspace file associations were written to this workspace.");
}
