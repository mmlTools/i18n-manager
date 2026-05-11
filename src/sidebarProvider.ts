import * as vscode from 'vscode';
import { I18nService } from './i18nService';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _service: I18nService,
  ) {}

  public refresh() {
    if (this._view) {
      void this.sendState();
    }
  }

  private async sendState() {
    if (!this._view) return;
    try {
      const state = await this._service.loadState();
      this._view.webview.postMessage({ type: "state", payload: state });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this._view.webview.postMessage({ type: "error", payload: msg });
    }
  }

  /** Ask the user to pick a source language from the given candidates. */
  private async pickSourceLanguage(
    candidates: string[],
    defaultLanguage: string,
    placeHolder: string,
    title: string,
  ): Promise<string | undefined> {
    if (candidates.length === 0) return undefined;
    const def = candidates.includes(defaultLanguage)
      ? defaultLanguage
      : candidates[0];
    const items: vscode.QuickPickItem[] = candidates.map((code) => ({
      label: code,
      description: code === def ? "(default - recommended)" : "",
    }));
    // Move the default to the top so it's preselected visually.
    items.sort((a, b) => (a.label === def ? -1 : b.label === def ? 1 : 0));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder,
      title,
    });
    return picked?.label;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (data: { type: string; payload?: any }) => {
        try {
          switch (data.type) {
            case "ready":
              await this.sendState();
              break;
            case "configure":
              await vscode.commands.executeCommand(
                "LocaleSynci18n.configureFolder",
              );
              break;
            case "useSuggestion": {
              const folderPath: string = data.payload?.folderPath;
              if (folderPath) {
                await this._service.setTranslationsFolder(folderPath);
                // The settings change will trigger refresh + watcher rewire,
                // but call refresh defensively in case the listener races.
                await this.sendState();
              }
              break;
            }
            case "addKey":
              await this._service.addKey(data.payload.key, data.payload.values);
              await this.sendState();
              vscode.window.setStatusBarMessage(
                `i18n: added key "${data.payload.key}"`,
                3000,
              );
              break;
            case "updateValue":
              await this._service.updateValue(
                data.payload.key,
                data.payload.language,
                data.payload.value,
              );
              await this.sendState();
              break;
            case "deleteKey": {
              const confirm = await vscode.window.showWarningMessage(
                `Delete key "${data.payload.key}" from all language files?`,
                { modal: true },
                "Delete",
              );
              if (confirm === "Delete") {
                await this._service.deleteKey(data.payload.key);
                await this.sendState();
              }
              break;
            }
            case "renameKey":
              await this._service.renameKey(
                data.payload.oldKey,
                data.payload.newKey,
              );
              await this.sendState();
              break;
            case "addLanguage": {
              const code: string = data.payload.code;
              const copyFrom: string | undefined = data.payload.copyFrom;
              const autoTranslate: boolean = !!data.payload.autoTranslate;
              await this._service.addLanguage(code, copyFrom);
              await this.sendState();
              vscode.window.setStatusBarMessage(
                `i18n: created "${code}.json"`,
                3000,
              );

              if (autoTranslate) {
                const state = await this._service.loadState();
                if (!state.aiAvailable) {
                  vscode.window.showWarningMessage(
                    "Auto-translate skipped: no AI provider available. Install GitHub Copilot (or another VS Code language model provider) and try again.",
                  );
                  break;
                }
                const sourceLang =
                  copyFrom ||
                  state.defaultLanguage ||
                  state.languages.find((l) => l.code !== code)?.code;
                if (!sourceLang || sourceLang === code) {
                  vscode.window.showWarningMessage(
                    "Auto-translate skipped: no source language available.",
                  );
                  break;
                }
                const result = await vscode.window.withProgress(
                  {
                    location: vscode.ProgressLocation.Notification,
                    title: `Auto-translating "${code}" from ${sourceLang}…`,
                    cancellable: true,
                  },
                  async (progress, token) =>
                    this._service.translateLanguageFile(
                      code,
                      sourceLang,
                      { overwrite: true },
                      token,
                      progress,
                    ),
                );
                await this.sendState();
                const parts = [
                  `Auto-translated ${result.translated} key${result.translated === 1 ? "" : "s"} into "${code}"`,
                ];
                if (result.skipped > 0)
                  parts.push(`skipped ${result.skipped}`);
                if (result.failed > 0)
                  parts.push(`${result.failed} failed`);
                vscode.window.showInformationMessage(parts.join(", ") + ".");
              }
              break;
            }
            case "deleteLanguage": {
              const confirm = await vscode.window.showWarningMessage(
                `Delete language file "${data.payload.code}.json"? This cannot be undone.`,
                { modal: true },
                "Delete",
              );
              if (confirm === "Delete") {
                await this._service.deleteLanguage(data.payload.code);
                await this.sendState();
              }
              break;
            }
            case "syncMissing": {
              const writes = await this._service.syncMissingKeys();
              await this.sendState();
              vscode.window.showInformationMessage(
                writes === 0
                  ? "All language files are already in sync."
                  : `Filled missing keys in ${writes} file${writes === 1 ? "" : "s"}.`,
              );
              break;
            }
            case "translateValue": {
              // Translate a single language for a single key. The user picks
              // which OTHER language to use as the source.
              const { key, targetLang } = data.payload;
              const state = await this._service.loadState();
              if (!state.aiAvailable) {
                vscode.window.showWarningMessage(
                  "AI translation is not available. Install GitHub Copilot (or another VS Code language model provider) and try again.",
                );
                break;
              }
              const candidates = state.languages
                .filter(
                  (l) =>
                    l.code !== targetLang &&
                    (l.flattened[key] ?? "").trim() !== "",
                )
                .map((l) => l.code);
              if (candidates.length === 0) {
                vscode.window.showInformationMessage(
                  `No other language has a value for "${key}". Fill at least one in to use as the translation source.`,
                );
                break;
              }
              const sourceLang = await this.pickSourceLanguage(
                candidates,
                state.defaultLanguage,
                `Translate "${key}" → ${targetLang} from which language?`,
                "AI Translate",
              );
              if (!sourceLang) break;
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: `Translating "${key}" from ${sourceLang} → ${targetLang}…`,
                  cancellable: true,
                },
                async (_progress, token) => {
                  await this._service.translateValue(
                    key,
                    sourceLang,
                    targetLang,
                    token,
                  );
                },
              );
              await this.sendState();
              vscode.window.setStatusBarMessage(
                `i18n: translated "${key}" → ${targetLang}`,
                3000,
              );
              break;
            }
            case "translateKey": {
              // Translate a single key into EVERY other language at once,
              // based on a user-selected source language.
              const { key } = data.payload;
              const state = await this._service.loadState();
              if (!state.aiAvailable) {
                vscode.window.showWarningMessage(
                  "AI translation is not available. Install GitHub Copilot (or another VS Code language model provider) and try again.",
                );
                break;
              }
              if (state.languages.length < 2) {
                vscode.window.showInformationMessage(
                  "Add at least one more language file before translating to all languages.",
                );
                break;
              }
              const candidates = state.languages
                .filter((l) => (l.flattened[key] ?? "").trim() !== "")
                .map((l) => l.code);
              if (candidates.length === 0) {
                vscode.window.showInformationMessage(
                  `No language has a value for "${key}". Fill at least one in to use as the translation source.`,
                );
                break;
              }
              const sourceLang = await this.pickSourceLanguage(
                candidates,
                state.defaultLanguage,
                `Translate "${key}" to all other languages - pick the source`,
                "AI Translate (All Languages)",
              );
              if (!sourceLang) break;

              // If any target already has a value, ask before overwriting.
              const conflicts = state.languages.filter(
                (l) =>
                  l.code !== sourceLang &&
                  (l.flattened[key] ?? "").trim() !== "",
              );
              let overwrite = true;
              if (conflicts.length > 0) {
                const choice = await vscode.window.showWarningMessage(
                  `${conflicts.length} language${conflicts.length === 1 ? "" : "s"} already ` +
                    `${conflicts.length === 1 ? "has" : "have"} a translation for "${key}". ` +
                    `Overwrite ${conflicts.length === 1 ? "it" : "them"}, or only fill empty ones?`,
                  { modal: true },
                  "Overwrite all",
                  "Only fill empty",
                );
                if (!choice) break;
                overwrite = choice === "Overwrite all";
              }

              const result = await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: `Translating "${key}" to all languages from ${sourceLang}…`,
                  cancellable: true,
                },
                async (progress, token) =>
                  this._service.translateKeyToAll(
                    key,
                    sourceLang,
                    { overwrite },
                    token,
                    progress,
                  ),
              );
              await this.sendState();
              const parts = [
                `Translated ${result.translated} language${result.translated === 1 ? "" : "s"}`,
              ];
              if (result.skipped > 0) {
                parts.push(`skipped ${result.skipped} that already had values`);
              }
              vscode.window.showInformationMessage(parts.join(", ") + ".");
              break;
            }
            case "openFile": {
              const uri = vscode.Uri.file(data.payload.filePath);
              await vscode.window.showTextDocument(uri, { preview: false });
              break;
            }
            case "refresh":
              await this.sendState();
              break;
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`i18n Data Manager: ${msg}`);
        }
      },
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.css"),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>i18n Data Manager</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
