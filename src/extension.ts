import * as vscode from 'vscode';
import * as path from 'path';
import { SidebarProvider } from './sidebarProvider';
import { I18nService } from './i18nService';

export function activate(context: vscode.ExtensionContext) {
  const i18nService = new I18nService();
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    i18nService,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "i18nDataManagerSidebar",
      sidebarProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );

  // Refresh when configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("i18nDataManager")) {
        sidebarProvider.refresh();
      }
    }),
  );

  // Refresh when extensions are installed/uninstalled/enabled so the AI
  // buttons appear automatically the moment the user installs Copilot (or
  // any other LM provider) and disappear if they remove it.
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => sidebarProvider.refresh()),
  );

  // Watch the configured translations folder for external changes
  let watcher: vscode.FileSystemWatcher | undefined;
  const setupWatcher = () => {
    watcher?.dispose();
    const folder = i18nService.resolveFolderPath();
    if (folder) {
      const pattern = new vscode.RelativePattern(folder, "*.json");
      watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(() => sidebarProvider.refresh());
      watcher.onDidCreate(() => sidebarProvider.refresh());
      watcher.onDidDelete(() => sidebarProvider.refresh());
      context.subscriptions.push(watcher);
    }
  };
  setupWatcher();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("i18nDataManager.translationsPath")) {
        setupWatcher();
      }
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "i18nDataManager.configureFolder",
      async () => {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
          vscode.window.showErrorMessage("Open a workspace first.");
          return;
        }
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: ws.uri,
          openLabel: "Select Translations Folder",
        });
        if (!picked || picked.length === 0) return;
        const absolute = picked[0].fsPath;
        let toSave = absolute;
        const wsPath = ws.uri.fsPath;
        if (absolute.startsWith(wsPath)) {
          toSave = path.relative(wsPath, absolute) || ".";
        }
        await vscode.workspace
          .getConfiguration("i18nDataManager")
          .update(
            "translationsPath",
            toSave,
            vscode.ConfigurationTarget.Workspace,
          );
        sidebarProvider.refresh();
        setupWatcher();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("i18nDataManager.refresh", () =>
      sidebarProvider.refresh(),
    ),
  );
}

export function deactivate() {}
