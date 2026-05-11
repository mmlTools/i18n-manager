import * as vscode from 'vscode';
import { I18nService, I18nState } from './i18nService';
import {
  DEFAULT_SELECTORS,
  findHardcodedStrings,
  findKeyReferences,
  isSupportedDocument,
} from './keyDetector';

/**
 * Cached i18n state shared by hover/codelens/diagnostics so we don't reload
 * the JSON files on every keystroke. Refreshed on a debounce when files
 * change or the configuration changes.
 */
class StateCache {
  private cached?: I18nState;
  private inflight?: Promise<I18nState>;
  private listeners = new Set<() => void>();

  constructor(private service: I18nService) {}

  current(): I18nState | undefined {
    return this.cached;
  }

  async ensure(): Promise<I18nState> {
    if (this.cached) return this.cached;
    if (!this.inflight) {
      this.inflight = this.service.loadState().then((s) => {
        this.cached = s;
        this.inflight = undefined;
        return s;
      });
    }
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
    this.inflight = undefined;
    void this.ensure().then(() => this.listeners.forEach((l) => l()));
  }

  onChange(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }
}

export function registerLanguageFeatures(
  context: vscode.ExtensionContext,
  service: I18nService,
  refreshSidebar: () => void,
): {
  invalidate: () => void;
  cache: { current(): I18nState | undefined; ensure(): Promise<I18nState> };
} {
  const cache = new StateCache(service);
  void cache.ensure();

  const config = () => vscode.workspace.getConfiguration('LocaleSynci18n');

  const featureEnabled = (name: 'hover' | 'codeLens' | 'diagnostics' | 'hardcodedDetection'): boolean => {
    return config().get<boolean>(`codeIntegration.${name}`, true);
  };

  // ─── Hover ─────────────────────────────────────────────────
  const hover: vscode.HoverProvider = {
    provideHover(document, position) {
      if (!featureEnabled('hover')) return;
      if (!isSupportedDocument(document)) return;
      const state = cache.current();
      if (!state || !state.configured) return;
      const refs = findKeyReferences(document);
      const ref = refs.find((r) => r.range.contains(position));
      if (!ref) return;
      return new vscode.Hover(buildHoverMarkdown(ref.key, state), ref.range);
    },
  };
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(DEFAULT_SELECTORS, hover),
  );

  // ─── CodeLens ──────────────────────────────────────────────
  const codeLensEmitter = new vscode.EventEmitter<void>();
  const codeLens: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: codeLensEmitter.event,
    provideCodeLenses(document) {
      if (!featureEnabled('codeLens')) return [];
      if (!isSupportedDocument(document)) return [];
      const state = cache.current();
      if (!state || !state.configured) return [];
      const def = state.languages.find((l) => l.code === state.defaultLanguage)
        || state.languages[0];
      if (!def) return [];
      const refs = findKeyReferences(document);
      // Only one lens per line to avoid clutter.
      const seenLines = new Set<number>();
      const lenses: vscode.CodeLens[] = [];
      for (const r of refs) {
        const line = r.fullRange.start.line;
        if (seenLines.has(line)) continue;
        seenLines.add(line);
        const value = def.flattened[r.key];
        const present = value !== undefined;
        const truncated = present
          ? truncate(value || '(empty)', 80)
          : `⚠ missing in ${def.code}`;
        lenses.push(
          new vscode.CodeLens(r.fullRange, {
            title: `${def.code}: ${truncated}`,
            command: 'LocaleSynci18n.revealKey',
            arguments: [r.key],
          }),
        );
      }
      return lenses;
    },
  };
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(DEFAULT_SELECTORS, codeLens),
  );

  // ─── Diagnostics ───────────────────────────────────────────
  const diagnostics = vscode.languages.createDiagnosticCollection('localesync-i18n');
  context.subscriptions.push(diagnostics);

  const updateDiagnostics = (document: vscode.TextDocument): void => {
    if (!isSupportedDocument(document)) {
      diagnostics.delete(document.uri);
      return;
    }
    const state = cache.current();
    if (!state || !state.configured) {
      diagnostics.delete(document.uri);
      return;
    }
    const items: vscode.Diagnostic[] = [];

    if (featureEnabled('diagnostics')) {
      const refs = findKeyReferences(document);
      for (const ref of refs) {
        if (!state.keys.includes(ref.key)) {
          const d = new vscode.Diagnostic(
            ref.range,
            `i18n key "${ref.key}" is not defined in any language file.`,
            vscode.DiagnosticSeverity.Warning,
          );
          d.code = 'i18n.missingKey';
          d.source = 'i18n';
          items.push(d);
        } else {
          // Flag languages where this key is empty.
          const empty = state.languages
            .filter((l) => !(l.flattened[ref.key] ?? '').trim())
            .map((l) => l.code);
          if (empty.length > 0) {
            const d = new vscode.Diagnostic(
              ref.range,
              `i18n key "${ref.key}" has no value in: ${empty.join(', ')}`,
              vscode.DiagnosticSeverity.Information,
            );
            d.code = 'i18n.emptyTranslation';
            d.source = 'i18n';
            items.push(d);
          }
        }
      }
    }

    if (featureEnabled('hardcodedDetection')) {
      const hardcoded = findHardcodedStrings(document);
      for (const h of hardcoded) {
        const d = new vscode.Diagnostic(
          h.range,
          `Hardcoded UI string: "${truncate(h.text, 60)}". Extract into a translation key?`,
          vscode.DiagnosticSeverity.Hint,
        );
        d.code = 'i18n.hardcodedString';
        d.source = 'i18n';
        d.tags = [vscode.DiagnosticTag.Unnecessary];
        items.push(d);
      }
    }

    diagnostics.set(document.uri, items);
  };

  // ─── Quick-fix for hardcoded strings: extract to key ───────
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(DEFAULT_SELECTORS, {
      provideCodeActions(document, _range, ctx) {
        const actions: vscode.CodeAction[] = [];
        for (const d of ctx.diagnostics) {
          if (d.source !== 'i18n') continue;
          if (d.code === 'i18n.hardcodedString') {
            const fix = new vscode.CodeAction(
              'i18n: Extract to translation key (AI)',
              vscode.CodeActionKind.QuickFix,
            );
            fix.command = {
              command: 'LocaleSynci18n.extractToKey',
              title: 'Extract to translation key',
              arguments: [document.uri, d.range],
            };
            fix.diagnostics = [d];
            actions.push(fix);
          } else if (d.code === 'i18n.missingKey') {
            const create = new vscode.CodeAction(
              'i18n: Create this key',
              vscode.CodeActionKind.QuickFix,
            );
            create.command = {
              command: 'LocaleSynci18n.createMissingKey',
              title: 'Create missing key',
              arguments: [document.uri, d.range],
            };
            create.diagnostics = [d];
            actions.push(create);
          }
        }
        return actions;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );

  // ─── Cache invalidation triggers ───────────────────────────
  const invalidate = () => {
    cache.invalidate();
    codeLensEmitter.fire();
    for (const editor of vscode.window.visibleTextEditors) {
      updateDiagnostics(editor.document);
    }
    refreshSidebar();
  };

  context.subscriptions.push(
    cache.onChange(() => {
      codeLensEmitter.fire();
      for (const editor of vscode.window.visibleTextEditors) {
        updateDiagnostics(editor.document);
      }
    }),
  );

  // Diagnostics on open/edit.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Debounce per document.
      scheduleUpdate(e.document, updateDiagnostics);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateDiagnostics(editor.document);
    }),
  );
  for (const editor of vscode.window.visibleTextEditors) {
    updateDiagnostics(editor.document);
  }

  // ─── Reveal key command (used by CodeLens) ─────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('LocaleSynci18n.revealKey', async (key: string) => {
      const state = await cache.ensure();
      if (!state.configured) return;
      const def = state.languages.find((l) => l.code === state.defaultLanguage)
        || state.languages[0];
      if (!def) return;
      const doc = await vscode.workspace.openTextDocument(def.filePath);
      const text = doc.getText();
      // Search for "lastSegment" in the JSON. Imperfect but practical.
      const last = key.split('.').pop() || key;
      const idx = text.indexOf(`"${last}"`);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (idx >= 0) {
        const pos = doc.positionAt(idx);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
  );

  return {
    invalidate,
    cache: { current: () => cache.current(), ensure: () => cache.ensure() },
  };
}

// ─── Helpers ──────────────────────────────────────────────────

const updateTimers = new WeakMap<vscode.TextDocument, NodeJS.Timeout>();
function scheduleUpdate(
  document: vscode.TextDocument,
  fn: (doc: vscode.TextDocument) => void,
): void {
  const existing = updateTimers.get(document);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    updateTimers.delete(document);
    fn(document);
  }, 250);
  updateTimers.set(document, t);
}

function buildHoverMarkdown(key: string, state: I18nState): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportHtml = false;
  md.appendMarkdown(`**i18n key**: \`${escapeMd(key)}\`\n\n`);
  if (state.languages.length === 0) {
    md.appendMarkdown('_No language files configured._');
    return md;
  }
  const rows: string[] = [];
  rows.push('| Lang | Value |');
  rows.push('| --- | --- |');
  // Default language first, then alphabetical.
  const sorted = [...state.languages].sort((a, b) => {
    if (a.code === state.defaultLanguage) return -1;
    if (b.code === state.defaultLanguage) return 1;
    return a.code.localeCompare(b.code);
  });
  let anyValue = false;
  for (const lang of sorted) {
    const v = lang.flattened[key];
    if (v === undefined) {
      rows.push(`| \`${lang.code}\` | _⚠ missing_ |`);
    } else if (v.trim() === '') {
      rows.push(`| \`${lang.code}\` | _empty_ |`);
    } else {
      anyValue = true;
      rows.push(`| \`${lang.code}\` | ${escapeMdCell(v)} |`);
    }
  }
  md.appendMarkdown(rows.join('\n'));
  if (!anyValue && !state.keys.includes(key)) {
    md.appendMarkdown('\n\n_Key not defined in any language file._');
  }
  md.appendMarkdown('\n\n');
  md.appendMarkdown(
    `[Open in editor](command:LocaleSynci18n.revealKey?${encodeURIComponent(JSON.stringify(key))}) · ` +
      `[Translate to all](command:LocaleSynci18n.translateKeyAllFromHover?${encodeURIComponent(JSON.stringify(key))}) · ` +
      `[Rename globally](command:LocaleSynci18n.renameKeyGlobal?${encodeURIComponent(JSON.stringify(key))})`,
  );
  return md;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!>|])/g, '\\$1');
}

function escapeMdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);
}
