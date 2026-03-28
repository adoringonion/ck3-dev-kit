import * as path from "path";
import * as vscode from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";
import { ResolvedConfig } from "../extension/config";

export function createLanguageClient(
  context: vscode.ExtensionContext,
  config: ResolvedConfig,
  outputChannel: vscode.OutputChannel
): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join("dist", "lsp", "server.js"));
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ["--nolazy", "--inspect=6009"],
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", pattern: "**/*.{txt,gui,info,asset,yml}" },
    ],
    initializationOptions: config,
    outputChannel,
  };

  return new LanguageClient("ck3ModDevkitLsp", "CK3 Mod DevKit Language Server", serverOptions, clientOptions);
}
