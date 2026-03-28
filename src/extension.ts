import * as fs from "fs";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { BackendManager } from "./extension/backendManager";
import { IndexStore } from "./extension/indexStore";
import { registerProviders } from "./extension/providers";
import { writeWorkspaceAssociations } from "./extension/workspaceSettings";
import { readConfig } from "./extension/config";
import { createLanguageClient } from "./lsp/client";
import {
  ANALYZE_ERROR_LOG_REQUEST,
  AnalyzeErrorLogResponse,
  INDEX_STATUS_NOTIFICATION,
  IndexStatusPayload,
} from "./lsp/protocol";

let activeBackendManager: BackendManager<LanguageClient> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("CK3 Mod DevKit");
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "CK3 Mod DevKit";
  context.subscriptions.push(output);
  context.subscriptions.push(statusBar);
  let indexBusy = false;
  let fallbackStore: IndexStore | undefined;

  const backendManager = new BackendManager<LanguageClient>({
    createLanguageClient: async () => {
      const nextClient = createLanguageClient(context, readConfig(), output);
      nextClient.onNotification(INDEX_STATUS_NOTIFICATION, (payload: IndexStatusPayload) => {
        const timestamp = `[${new Date().toISOString()}]`;
        if (payload.phase === "started") {
          indexBusy = true;
          statusBar.text = "$(sync~spin) CK3 Indexing";
          statusBar.tooltip = `CK3 Mod DevKit is building the symbol index (${payload.reason}).`;
          statusBar.show();
          output.appendLine(`${timestamp} Index build started: ${payload.reason}`);
          return;
        }
        if (payload.phase === "busy") {
          indexBusy = true;
          statusBar.text = "$(sync~spin) CK3 Indexing";
          statusBar.tooltip = "CK3 Mod DevKit is already building the symbol index.";
          statusBar.show();
          output.appendLine(`${timestamp} Index build already in progress: ${payload.reason}`);
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
      context.subscriptions.push(nextClient);
      output.appendLine(`[${new Date().toISOString()}] Starting language server.`);
      await nextClient.start();
      output.appendLine(`[${new Date().toISOString()}] Language server started.`);
      return nextClient;
    },
    registerFallbackProviders: () => {
      fallbackStore ??= new IndexStore();
      return registerProviders(context, fallbackStore);
    },
    rebuildFallbackIndex: async () => {
      fallbackStore ??= new IndexStore();
      await fallbackStore.rebuild();
    },
  });
  activeBackendManager = backendManager;

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
      const activeBackend = await backendManager.rebuild();
      if (activeBackend === "fallback") {
        output.appendLine(`[${new Date().toISOString()}] Fallback index rebuilt.`);
      } else if (activeBackend === "none") {
        output.appendLine(`[${new Date().toISOString()}] No active language backend to rebuild.`);
      }
      output.appendLine(`[${new Date().toISOString()}] Index rebuild complete.`);
      if (notify) {
        vscode.window.showInformationMessage("CK3 symbol index rebuilt.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      output.appendLine(`[${new Date().toISOString()}] Index rebuild failed.`);
      output.appendLine(message);
      void vscode.window.showErrorMessage("CK3 Mod DevKit failed to build its index. Check the 'CK3 Mod DevKit' output channel.");
    }
  };

  void promptForWorkspaceAssociations();
  try {
    await backendManager.start();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    output.appendLine(`[${new Date().toISOString()}] Language server failed to start. Falling back to direct providers.`);
    output.appendLine(message);
    backendManager.enableFallback();
    void vscode.window.showWarningMessage("CK3 Mod DevKit language server failed to start. Using fallback providers.");
    void rebuildIndex("fallback activation");
  }

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

      const client = backendManager.getLanguageClient();
      if (!client) {
        void vscode.window.showWarningMessage("CK3 Mod DevKit language server is not running. error.log analysis is unavailable in fallback mode.");
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
      if (event.affectsConfiguration("ck3ModDevkit")) {
        try {
          await backendManager.restart();
        } catch (error) {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          output.appendLine(`[${new Date().toISOString()}] Language server restart failed.`);
          output.appendLine(message);
          backendManager.enableFallback();
        }
        if (backendManager.isUsingFallback()) {
          await rebuildIndex("configuration change");
        }
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  await activeBackendManager?.deactivate();
  activeBackendManager = undefined;
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
