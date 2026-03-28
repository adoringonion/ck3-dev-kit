import * as fs from "fs";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { writeWorkspaceAssociations } from "./extension/workspaceSettings";
import { readConfig } from "./extension/config";
import { createLanguageClient } from "./lsp/client";
import {
  ANALYZE_ERROR_LOG_REQUEST,
  AnalyzeErrorLogResponse,
  INDEX_STATUS_NOTIFICATION,
  IndexStatusPayload,
  REBUILD_INDEX_NOTIFICATION,
} from "./lsp/protocol";

let activeLanguageClient: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("CK3 Mod DevKit");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "CK3 Mod DevKit";
  context.subscriptions.push(output, statusBar);

  let indexBusy = false;
  let client = createLanguageClient(context, readConfig(), output);
  activeLanguageClient = client;

  const bindClientNotifications = (languageClient: LanguageClient) => {
    languageClient.onNotification(INDEX_STATUS_NOTIFICATION, (payload: IndexStatusPayload) => {
      const timestamp = `[${new Date().toISOString()}]`;
      if (payload.phase === "started" || payload.phase === "busy") {
        indexBusy = true;
        statusBar.text = "$(sync~spin) CK3 Indexing";
        statusBar.tooltip = payload.phase === "started"
          ? `CK3 Mod DevKit is building the symbol index (${payload.reason}).`
          : "CK3 Mod DevKit is already building the symbol index.";
        statusBar.show();
        output.appendLine(`${timestamp} Index build ${payload.phase === "started" ? "started" : "already in progress"}: ${payload.reason}`);
        return;
      }
      if (payload.phase === "completed") {
        indexBusy = false;
        statusBar.hide();
        output.appendLine(`${timestamp} Index build completed: ${payload.reason}`);
        if (payload.reason === "startup") {
          void vscode.window.setStatusBarMessage("CK3 symbol index ready.", 3000);
        }
        return;
      }

      indexBusy = false;
      statusBar.text = "$(error) CK3 Index Failed";
      statusBar.tooltip = payload.message ?? "CK3 Mod DevKit failed to build the symbol index.";
      statusBar.show();
      output.appendLine(`${timestamp} Index build failed: ${payload.reason}`);
      if (payload.message) {
        output.appendLine(payload.message);
      }
      void vscode.window.showErrorMessage("CK3 Mod DevKit failed to build its index. Check the 'CK3 Mod DevKit' output channel.");
    });
  };

  bindClientNotifications(client);
  output.appendLine(`[${new Date().toISOString()}] Starting language server.`);
  await client.start();
  output.appendLine(`[${new Date().toISOString()}] Language server started.`);

  const rebuildIndex = async (reason: string, notify = false) => {
    if (indexBusy) {
      output.appendLine(`[${new Date().toISOString()}] Skipped rebuild because indexing is already running: ${reason}`);
      if (notify) {
        void vscode.window.showInformationMessage("CK3 Mod DevKit is already building the symbol index.");
      }
      return;
    }
    try {
      output.appendLine(`[${new Date().toISOString()}] Rebuilding index: ${reason}`);
      await client.sendNotification(REBUILD_INDEX_NOTIFICATION);
      output.appendLine(`[${new Date().toISOString()}] Index rebuild requested.`);
      if (notify) {
        void vscode.window.showInformationMessage("CK3 symbol index rebuild requested.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      output.appendLine(`[${new Date().toISOString()}] Index rebuild failed.`);
      output.appendLine(message);
      void vscode.window.showErrorMessage("CK3 Mod DevKit failed to rebuild its index. Check the 'CK3 Mod DevKit' output channel.");
    }
  };

  void promptForWorkspaceAssociations();

  context.subscriptions.push(
    vscode.commands.registerCommand("ck3ModDevkit.associateWorkspace", async () => {
      await writeWorkspaceAssociations();
    }),
    vscode.commands.registerCommand("ck3ModDevkit.rebuildIndex", async () => {
      await rebuildIndex("manual command", true);
    }),
    vscode.commands.registerCommand("ck3ModDevkit.analyzeErrorLog", async () => {
      const config = readConfig();
      if (!fs.existsSync(config.errorLogPath)) {
        void vscode.window.showErrorMessage(`CK3 error.log was not found: ${config.errorLogPath}`);
        return;
      }

      const analysis = await client.sendRequest<AnalyzeErrorLogResponse>(ANALYZE_ERROR_LOG_REQUEST, {
        logPath: config.errorLogPath,
      });

      output.appendLine(`[${new Date().toISOString()}] Analyzed error.log: ${analysis.file}`);
      output.appendLine(`Findings: ${analysis.summary.totalFindings} total, ${analysis.summary.modRelatedFindings} mod-related.`);
      for (const finding of analysis.findings.slice(0, 50)) {
        const scope = finding.modRelated ? "mod" : "non-mod";
        const location = finding.gamePath
          ? `${finding.gamePath}${finding.fileLine ? `:${finding.fileLine}` : ""}`
          : "unknown location";
        output.appendLine(
          `- [${finding.severity}] [${scope}] [${finding.category}] x${finding.occurrences} ${finding.message} (${location})`
        );
        if (finding.suggestion) {
          output.appendLine(`  suggestion: ${finding.suggestion}`);
        }
      }
      output.show(true);

      void vscode.window.showInformationMessage(
        analysis.summary.modRelatedFindings === 0
          ? "CK3 error.log analysis found no mod-related issues."
          : `CK3 error.log analysis found ${analysis.summary.modRelatedFindings} mod-related issues.`
      );
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("ck3ModDevkit")) {
        return;
      }
      output.appendLine(`[${new Date().toISOString()}] Restarting language server after configuration change.`);
      await client.stop();
      client = createLanguageClient(context, readConfig(), output);
      activeLanguageClient = client;
      bindClientNotifications(client);
      await client.start();
    })
  );
}

export async function deactivate(): Promise<void> {
  if (!activeLanguageClient) {
    return;
  }
  const client = activeLanguageClient;
  activeLanguageClient = undefined;
  await client.stop();
}

async function promptForWorkspaceAssociations(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return;
  }

  const filesConfig = vscode.workspace.getConfiguration("files");
  const associations = filesConfig.get<Record<string, string>>("associations", {});
  const hasCk3TxtAssociation = Object.entries(associations).some(([pattern, language]) =>
    language === "ck3-script" && pattern.endsWith(".txt")
  );
  if (hasCk3TxtAssociation) {
    return;
  }

  const config = readConfig();
  if (config.modRoots.length === 0 && config.referenceRoots.length === 0) {
    return;
  }

  const selection = await vscode.window.showInformationMessage(
    "CK3 Mod DevKit can write workspace file associations so CK3 .txt files get syntax highlighting and language features.",
    "Write Associations",
    "Later"
  );
  if (selection === "Write Associations") {
    await writeWorkspaceAssociations();
  }
}
