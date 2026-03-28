import * as fs from "fs";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { analyzeErrorLogFile } from "./core/errorLog";
import { IndexStore } from "./extension/indexStore";
import { writeWorkspaceAssociations } from "./extension/workspaceSettings";
import { readConfig } from "./extension/config";
import { createLanguageClient } from "./lsp/client";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new IndexStore();
  const output = vscode.window.createOutputChannel("CK3 Mod DevKit");
  let rebuildTimer: NodeJS.Timeout | undefined;
  let languageClient: LanguageClient | undefined;
  context.subscriptions.push(output);

  const startLanguageServer = async () => {
    const nextClient = createLanguageClient(context, readConfig(), output);
    context.subscriptions.push(nextClient);
    await nextClient.start();
    languageClient = nextClient;
  };

  const restartLanguageServer = async () => {
    if (languageClient) {
      await languageClient.stop();
      languageClient = undefined;
    }
    await startLanguageServer();
  };

  const rebuildIndex = async (reason: string, notify = false) => {
    try {
      output.appendLine(`[${new Date().toISOString()}] Rebuilding index: ${reason}`);
      await store.rebuild();
      if (languageClient) {
        await languageClient.sendNotification("ck3/rebuildIndex");
      }
      for (const document of vscode.workspace.textDocuments) {
        store.syncTextDocument(document);
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

  const scheduleRebuild = (reason: string, notify = false, delayMs = 250) => {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
    }
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      void rebuildIndex(reason, notify);
    }, delayMs);
  };

  void promptForWorkspaceAssociations();
  await startLanguageServer();

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

      const index = await store.snapshot();
      const analysis = analyzeErrorLogFile({
        logPath: config.errorLogPath,
        modRoots: config.modRoots,
        referenceRoots: config.referenceRoots,
        index,
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
        scheduleRebuild("configuration change");
        await restartLanguageServer();
      }
    })
  );

  void rebuildIndex("activation");
}

export function deactivate(): void {}

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
