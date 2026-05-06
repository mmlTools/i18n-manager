import * as vscode from 'vscode';
import { I18nService } from './i18nService';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _service: I18nService
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
      this._view.webview.postMessage({ type: 'state', payload: state });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this._view.webview.postMessage({ type: 'error', payload: msg });
    }
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data: { type: string; payload?: any }) => {
      try {
        switch (data.type) {
          case 'ready':
            await this.sendState();
            break;
          case 'configure':
            await vscode.commands.executeCommand('i18nManager.configureFolder');
            break;
          case 'addKey':
            await this._service.addKey(data.payload.key, data.payload.values);
            await this.sendState();
            vscode.window.setStatusBarMessage(`i18n: added key "${data.payload.key}"`, 3000);
            break;
          case 'updateValue':
            await this._service.updateValue(
              data.payload.key,
              data.payload.language,
              data.payload.value
            );
            await this.sendState();
            break;
          case 'deleteKey': {
            const confirm = await vscode.window.showWarningMessage(
              `Delete key "${data.payload.key}" from all language files?`,
              { modal: true },
              'Delete'
            );
            if (confirm === 'Delete') {
              await this._service.deleteKey(data.payload.key);
              await this.sendState();
            }
            break;
          }
          case 'renameKey':
            await this._service.renameKey(data.payload.oldKey, data.payload.newKey);
            await this.sendState();
            break;
          case 'addLanguage':
            await this._service.addLanguage(data.payload.code, data.payload.copyFrom);
            await this.sendState();
            vscode.window.setStatusBarMessage(`i18n: created "${data.payload.code}.json"`, 3000);
            break;
          case 'deleteLanguage': {
            const confirm = await vscode.window.showWarningMessage(
              `Delete language file "${data.payload.code}.json"? This cannot be undone.`,
              { modal: true },
              'Delete'
            );
            if (confirm === 'Delete') {
              await this._service.deleteLanguage(data.payload.code);
              await this.sendState();
            }
            break;
          }
          case 'syncMissing': {
            const writes = await this._service.syncMissingKeys();
            await this.sendState();
            vscode.window.showInformationMessage(
              writes === 0
                ? 'All language files are already in sync.'
                : `Filled missing keys in ${writes} file${writes === 1 ? '' : 's'}.`
            );
            break;
          }
          case 'openFile': {
            const uri = vscode.Uri.file(data.payload.filePath);
            await vscode.window.showTextDocument(uri, { preview: false });
            break;
          }
          case 'refresh':
            await this.sendState();
            break;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`i18n Manager: ${msg}`);
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>i18n Manager</title>
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
