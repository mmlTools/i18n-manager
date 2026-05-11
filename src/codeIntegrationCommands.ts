import * as vscode from 'vscode';
import { I18nService, I18nState } from './i18nService';
import { SidebarProvider } from './sidebarProvider';
import { buildUsageIndex } from './usageScanner';
import { findKeyReferences } from './keyDetector';

/**
 * Register every "code-integration" command added in the v1.5 update:
 *  - findUnusedKeys
 *  - renameKeyGlobal     (also exposed from hover)
 *  - renameNamespace     (auto namespace refactor)
 *  - reviewTranslations  (AI quality review of one key)
 *  - extractToKey        (quick-fix for hardcoded strings)
 *  - createMissingKey    (quick-fix for missing-key diagnostics)
 *  - translateKeyAllFromHover (hover convenience)
 *  - showAllUsages       (find references to a single key)
 */
export function registerCodeIntegrationCommands(
  context: vscode.ExtensionContext,
  i18nService: I18nService,
  sidebarProvider: SidebarProvider,
  invalidateCache: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('LocaleSynci18n.findUnusedKeys', () =>
      findUnusedKeys(i18nService),
    ),
    vscode.commands.registerCommand(
      'LocaleSynci18n.renameKeyGlobal',
      (key?: string) => renameKeyGlobal(i18nService, sidebarProvider, invalidateCache, key),
    ),
    vscode.commands.registerCommand('LocaleSynci18n.renameNamespace', () =>
      renameNamespace(i18nService, sidebarProvider, invalidateCache),
    ),
    vscode.commands.registerCommand(
      'LocaleSynci18n.reviewTranslations',
      (key?: string) => reviewTranslations(i18nService, key),
    ),
    vscode.commands.registerCommand(
      'LocaleSynci18n.extractToKey',
      async (uri?: vscode.Uri, range?: vscode.Range) =>
        extractToKey(uri, range),
    ),
    vscode.commands.registerCommand(
      'LocaleSynci18n.createMissingKey',
      async (uri?: vscode.Uri, range?: vscode.Range) =>
        createMissingKey(i18nService, sidebarProvider, uri, range),
    ),
    vscode.commands.registerCommand(
      'LocaleSynci18n.translateKeyAllFromHover',
      async (key: string) => translateKeyAllFromHover(i18nService, sidebarProvider, key),
    ),
    vscode.commands.registerCommand(
      'LocaleSynci18n.showKeyUsages',
      (key?: string) => showKeyUsages(key),
    ),
  );
}

// ─── findUnusedKeys ─────────────────────────────────────────

async function findUnusedKeys(service: I18nService): Promise<void> {
  const state = await service.loadState();
  if (!ensureConfigured(state)) return;

  const index = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Scanning workspace for translation key usages…',
      cancellable: true,
    },
    (progress, token) => buildUsageIndex(token, progress),
  );

  const used = new Set(index.byKey.keys());
  // A key is also "used" if any other defined key starts with it + "." —
  // common with i18next nested-key lookups like t("forms.login").
  const allKeys = state.keys;
  const unused: string[] = [];
  for (const k of allKeys) {
    if (used.has(k)) continue;
    // Treat partial matches as used (parent of a referenced nested key).
    let isPrefixUsed = false;
    for (const u of used) {
      if (u.startsWith(k + '.') || k.startsWith(u + '.')) {
        isPrefixUsed = true;
        break;
      }
    }
    if (!isPrefixUsed) unused.push(k);
  }

  if (unused.length === 0) {
    vscode.window.showInformationMessage(
      `i18n: no unused keys found across ${index.filesScanned} source file${index.filesScanned === 1 ? '' : 's'}. Nice and tidy!`,
    );
    return;
  }

  type Item = vscode.QuickPickItem & { key: string };
  const items: Item[] = unused.map((k) => {
    const def = state.languages.find((l) => l.code === state.defaultLanguage)
      || state.languages[0];
    const preview = def?.flattened[k] ?? '';
    return {
      label: k,
      description: preview ? truncate(preview, 80) : '(empty)',
      key: k,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: `Unused translation keys (${unused.length} of ${allKeys.length})`,
    placeHolder:
      'Select keys to delete from every language file (multi-select). Esc to cancel.',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picked || picked.length === 0) return;

  const confirm = await vscode.window.showWarningMessage(
    `Delete ${picked.length} key${picked.length === 1 ? '' : 's'} from every language file? This cannot be undone.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  for (const item of picked) {
    await service.deleteKey(item.key);
  }
  vscode.window.showInformationMessage(
    `i18n: deleted ${picked.length} unused key${picked.length === 1 ? '' : 's'}.`,
  );
}

// ─── renameKeyGlobal ────────────────────────────────────────

async function renameKeyGlobal(
  service: I18nService,
  sidebar: SidebarProvider,
  invalidateCache: () => void,
  initialKey?: string,
): Promise<void> {
  const state = await service.loadState();
  if (!ensureConfigured(state)) return;

  const oldKey = initialKey || (await pickKey(state, 'Pick the key to rename'));
  if (!oldKey) return;
  if (!state.keys.includes(oldKey)) {
    vscode.window.showWarningMessage(`i18n: key "${oldKey}" does not exist.`);
    return;
  }

  const newKey = await vscode.window.showInputBox({
    title: `Rename "${oldKey}" globally`,
    prompt:
      'Renames the key in every language file AND every code reference in the workspace.',
    value: oldKey,
    valueSelection: [oldKey.lastIndexOf('.') + 1, oldKey.length],
    validateInput: (v) => {
      const t = (v || '').trim();
      if (!t) return 'New key cannot be empty.';
      if (t === oldKey) return 'New key is the same as the old key.';
      if (!/^[A-Za-z0-9_$][A-Za-z0-9_$.]*$/.test(t)) {
        return 'Use dot notation with letters, digits, _ and $ only.';
      }
      if (state.keys.includes(t)) return `Key "${t}" already exists.`;
      return null;
    },
  });
  if (!newKey) return;
  const target = newKey.trim();

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Renaming "${oldKey}" → "${target}"…`,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'Updating language files…' });
      await service.renameKey(oldKey, target);
      progress.report({ message: 'Scanning workspace for references…' });
      const index = await buildUsageIndex(token, progress);
      const refs = index.byKey.get(oldKey) ?? [];
      const edit = new vscode.WorkspaceEdit();
      for (const { uri, ref } of refs) {
        edit.replace(uri, ref.range, target);
      }
      const ok = await vscode.workspace.applyEdit(edit);
      // Save edited files so the user immediately sees the changes on disk.
      if (ok) {
        const uris = new Set(refs.map((r) => r.uri.toString()));
        for (const uriStr of uris) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
          if (doc.isDirty) await doc.save();
        }
      }
      return { refCount: refs.length, ok };
    },
  );

  invalidateCache();
  sidebar.refresh();
  vscode.window.showInformationMessage(
    `i18n: renamed "${oldKey}" → "${target}" (updated ${result.refCount} code reference${result.refCount === 1 ? '' : 's'}).`,
  );
}

// ─── renameNamespace ────────────────────────────────────────

async function renameNamespace(
  service: I18nService,
  sidebar: SidebarProvider,
  invalidateCache: () => void,
): Promise<void> {
  const state = await service.loadState();
  if (!ensureConfigured(state)) return;

  // Suggest existing namespaces.
  const namespaces = collectNamespaces(state.keys);
  type Item = vscode.QuickPickItem & { ns: string };
  const items: Item[] = namespaces.map((n) => ({
    label: n.prefix,
    description: `${n.count} key${n.count === 1 ? '' : 's'}`,
    ns: n.prefix,
  }));
  items.push({
    label: '$(edit) Custom prefix…',
    description: 'Type any prefix manually',
    ns: '',
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Auto Namespace Refactor — pick the namespace to rename',
    placeHolder: 'e.g. comp.foo  or  errors',
  });
  if (!picked) return;

  let oldPrefix = picked.ns;
  if (!oldPrefix) {
    const typed = await vscode.window.showInputBox({
      title: 'Namespace prefix to rename',
      prompt: 'e.g. "comp.foo" — every key starting with this prefix will be renamed.',
    });
    if (!typed) return;
    oldPrefix = typed.trim().replace(/\.+$/, '');
    if (!oldPrefix) return;
  }

  const newPrefix = await vscode.window.showInputBox({
    title: `Rename namespace "${oldPrefix}" →`,
    prompt: 'New prefix (dots allowed, e.g. "components.foo").',
    value: oldPrefix,
    valueSelection: [0, oldPrefix.length],
    validateInput: (v) => {
      const t = (v || '').trim().replace(/\.+$/, '');
      if (!t) return 'Prefix cannot be empty.';
      if (t === oldPrefix) return 'New prefix is the same as the old one.';
      if (!/^[A-Za-z0-9_$][A-Za-z0-9_$.]*$/.test(t)) return 'Invalid prefix.';
      return null;
    },
  });
  if (!newPrefix) return;
  const newP = newPrefix.trim().replace(/\.+$/, '');

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Refactoring namespace "${oldPrefix}" → "${newP}"…`,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'Updating language files…' });
      const mapping = await service.renameNamespace(oldPrefix, newP);
      const oldKeys = Object.keys(mapping);
      if (oldKeys.length === 0) return { mapping, refCount: 0 };
      progress.report({ message: 'Scanning workspace for references…' });
      const index = await buildUsageIndex(token, progress);
      const edit = new vscode.WorkspaceEdit();
      let refCount = 0;
      const dirtyUris = new Set<string>();
      for (const oldKey of oldKeys) {
        const refs = index.byKey.get(oldKey) ?? [];
        for (const { uri, ref } of refs) {
          edit.replace(uri, ref.range, mapping[oldKey]);
          refCount++;
          dirtyUris.add(uri.toString());
        }
      }
      if (refCount > 0) {
        await vscode.workspace.applyEdit(edit);
        for (const uriStr of dirtyUris) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
          if (doc.isDirty) await doc.save();
        }
      }
      return { mapping, refCount };
    },
  );

  invalidateCache();
  sidebar.refresh();
  const renamed = Object.keys(result.mapping).length;
  if (renamed === 0) {
    vscode.window.showInformationMessage(
      `i18n: no keys matched namespace "${oldPrefix}".`,
    );
  } else {
    vscode.window.showInformationMessage(
      `i18n: renamed ${renamed} key${renamed === 1 ? '' : 's'} (and ${result.refCount} code reference${result.refCount === 1 ? '' : 's'}).`,
    );
  }
}

// ─── reviewTranslations ─────────────────────────────────────

async function reviewTranslations(
  service: I18nService,
  initialKey?: string,
): Promise<void> {
  const state = await service.loadState();
  if (!ensureConfigured(state)) return;
  if (!state.aiAvailable) {
    vscode.window.showWarningMessage(
      'AI translation review needs a VS Code language model provider (e.g. GitHub Copilot).',
    );
    return;
  }
  if (state.languages.length < 2) {
    vscode.window.showInformationMessage(
      'Add at least two language files before running AI review.',
    );
    return;
  }

  const key = initialKey || (await pickKey(state, 'Pick the key to review'));
  if (!key) return;

  // Pick source language (must have a value).
  const candidates = state.languages
    .filter((l) => (l.flattened[key] ?? '').trim() !== '')
    .map((l) => l.code);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      `No language has a value for "${key}". Fill at least one in first.`,
    );
    return;
  }
  const def = candidates.includes(state.defaultLanguage)
    ? state.defaultLanguage
    : candidates[0];
  const sourceLang = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: c,
      description: c === def ? '(default — recommended)' : '',
    })),
    {
      title: `AI translation review for "${key}"`,
      placeHolder: 'Pick the source language to compare against',
    },
  );
  if (!sourceLang) return;

  const findings = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Reviewing translations of "${key}"…`,
      cancellable: true,
    },
    (_p, token) => service.reviewKeyTranslations(key, sourceLang.label, token),
  );

  // Surface results in an output channel + quick-pick summary.
  const channel = getReviewChannel();
  channel.show(true);
  channel.appendLine('');
  channel.appendLine(`▸ Review for "${key}" (source: ${sourceLang.label})`);
  for (const f of findings) {
    const icon = f.verdict === 'ok' ? '✓' : f.verdict === 'missing' ? '∅' : '⚠';
    channel.appendLine(`  ${icon} ${f.language.padEnd(6)}  ${f.comment}`);
  }
  const issues = findings.filter((f) => f.verdict !== 'ok');
  vscode.window.showInformationMessage(
    issues.length === 0
      ? `i18n: all translations of "${key}" look good.`
      : `i18n: ${issues.length} issue${issues.length === 1 ? '' : 's'} found for "${key}". See the "i18n Review" output channel.`,
  );
}

let reviewChannel: vscode.OutputChannel | undefined;
function getReviewChannel(): vscode.OutputChannel {
  if (!reviewChannel) reviewChannel = vscode.window.createOutputChannel('i18n Review');
  return reviewChannel;
}

// ─── extractToKey (quick-fix for hardcoded strings) ─────────

async function extractToKey(
  uri?: vscode.Uri,
  range?: vscode.Range,
): Promise<void> {
  // Find the editor for the given URI (or use the active editor as a fallback).
  let editor = vscode.window.activeTextEditor;
  if (uri && (!editor || editor.document.uri.toString() !== uri.toString())) {
    const doc = await vscode.workspace.openTextDocument(uri);
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  }
  if (!editor) return;
  if (range) {
    editor.selection = new vscode.Selection(range.start, range.end);
  }
  await vscode.commands.executeCommand('LocaleSynci18n.createKeyFromSelection');
}

// ─── createMissingKey (quick-fix for missing-key diagnostics) ─

async function createMissingKey(
  service: I18nService,
  sidebar: SidebarProvider,
  uri?: vscode.Uri,
  range?: vscode.Range,
): Promise<void> {
  if (!uri || !range) return;
  const doc = await vscode.workspace.openTextDocument(uri);
  const key = doc.getText(range);
  const state = await service.loadState();
  if (!ensureConfigured(state)) return;
  if (state.keys.includes(key)) {
    vscode.window.showInformationMessage(`i18n: key "${key}" already exists.`);
    return;
  }
  const sourceLang = state.defaultLanguage || state.languages[0]?.code;
  if (!sourceLang) return;
  const value = await vscode.window.showInputBox({
    title: `Create key "${key}"`,
    prompt: `Source value in ${sourceLang} (other languages will be left empty).`,
    value: '',
  });
  if (value === undefined) return;
  const values: Record<string, string> = {};
  for (const l of state.languages) values[l.code] = '';
  values[sourceLang] = value;
  await service.addKey(key, values);
  sidebar.refresh();
  vscode.window.setStatusBarMessage(`i18n: created "${key}"`, 3000);
}

// ─── translateKeyAllFromHover ───────────────────────────────

async function translateKeyAllFromHover(
  service: I18nService,
  sidebar: SidebarProvider,
  key: string,
): Promise<void> {
  const state = await service.loadState();
  if (!ensureConfigured(state)) return;
  if (!state.aiAvailable) {
    vscode.window.showWarningMessage(
      'AI translation needs a VS Code language model provider (e.g. GitHub Copilot).',
    );
    return;
  }
  const candidates = state.languages
    .filter((l) => (l.flattened[key] ?? '').trim() !== '')
    .map((l) => l.code);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      `No language has a value for "${key}". Fill one in first.`,
    );
    return;
  }
  const def = candidates.includes(state.defaultLanguage)
    ? state.defaultLanguage
    : candidates[0];
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Translating "${key}" to all languages from ${def}…`,
      cancellable: true,
    },
    (progress, token) =>
      service.translateKeyToAll(key, def, { overwrite: false }, token, progress),
  );
  sidebar.refresh();
  vscode.window.showInformationMessage(
    `i18n: translated "${key}" into ${result.translated} language${result.translated === 1 ? '' : 's'}` +
      (result.skipped > 0 ? `, skipped ${result.skipped}` : '') + '.',
  );
}

// ─── showKeyUsages ──────────────────────────────────────────

async function showKeyUsages(initialKey?: string): Promise<void> {
  let key = initialKey;
  if (!key) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const refs = findKeyReferences(editor.document);
      const ref = refs.find((r) => r.range.contains(editor.selection.active));
      if (ref) key = ref.key;
    }
  }
  if (!key) {
    key = await vscode.window.showInputBox({
      title: 'Find key references',
      prompt: 'Enter the i18n key to find',
    });
    if (!key) return;
  }

  const index = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Finding references to "${key}"…`,
      cancellable: true,
    },
    (progress, token) => buildUsageIndex(token, progress),
  );
  const refs = index.byKey.get(key) ?? [];
  if (refs.length === 0) {
    vscode.window.showInformationMessage(`i18n: no references to "${key}" found.`);
    return;
  }

  type Item = vscode.QuickPickItem & { uri: vscode.Uri; range: vscode.Range };
  const items: Item[] = await Promise.all(
    refs.map(async ({ uri, ref }) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = doc.lineAt(ref.range.start.line).text.trim();
      return {
        label: vscode.workspace.asRelativePath(uri),
        description: `Line ${ref.range.start.line + 1}`,
        detail: line.slice(0, 200),
        uri,
        range: ref.range,
      };
    }),
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: `${refs.length} reference${refs.length === 1 ? '' : 's'} to "${key}"`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  const doc = await vscode.workspace.openTextDocument(picked.uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  editor.selection = new vscode.Selection(picked.range.start, picked.range.end);
  editor.revealRange(picked.range, vscode.TextEditorRevealType.InCenter);
}

// ─── shared helpers ─────────────────────────────────────────

function ensureConfigured(state: I18nState): boolean {
  if (!state.configured) {
    vscode.window.showWarningMessage(
      'Configure your translations folder first (i18n Data Manager sidebar).',
    );
    return false;
  }
  if (state.languages.length === 0) {
    vscode.window.showWarningMessage(
      'Add at least one language file first (i18n Data Manager sidebar).',
    );
    return false;
  }
  return true;
}

async function pickKey(state: I18nState, title: string): Promise<string | undefined> {
  const def = state.languages.find((l) => l.code === state.defaultLanguage)
    || state.languages[0];
  const items: vscode.QuickPickItem[] = state.keys.map((k) => ({
    label: k,
    description: def?.flattened[k] ? truncate(def.flattened[k], 80) : '(empty)',
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Type to filter…',
    matchOnDescription: true,
  });
  return picked?.label;
}

function collectNamespaces(keys: string[]): Array<{ prefix: string; count: number }> {
  // Use 1- and 2-segment prefixes that group at least 2 keys.
  const counts = new Map<string, number>();
  for (const k of keys) {
    const parts = k.split('.');
    if (parts.length < 2) continue;
    counts.set(parts[0], (counts.get(parts[0]) ?? 0) + 1);
    if (parts.length >= 3) {
      const two = parts[0] + '.' + parts[1];
      counts.set(two, (counts.get(two) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([prefix, count]) => ({ prefix, count }));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
