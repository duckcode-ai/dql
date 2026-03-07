import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const bundledServer = context.asAbsolutePath(path.join('dist', 'lsp-server.js'));
  const serverOptions: ServerOptions = {
    run: {
      module: bundledServer,
      transport: TransportKind.ipc,
    },
    debug: {
      module: bundledServer,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'dql' },
      { scheme: 'untitled', language: 'dql' },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.dql'),
    },
  };

  client = new LanguageClient('dqlLanguageServer', 'DQL Language Server', serverOptions, clientOptions);
  context.subscriptions.push(client);
  await client.start();
}

export async function deactivate(): Promise<void> {
  if (!client) return;
  await client.stop();
}
