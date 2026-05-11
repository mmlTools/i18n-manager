import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import { I18nService } from './i18nService';
import { registerLanguageFeatures } from './languageFeatures';
import { registerCodeIntegrationCommands } from './codeIntegrationCommands';

export function activate(context: vscode.ExtensionContext) {
  const i18nService = new I18nService();
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    i18nService,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "LocaleSynci18nSidebar",
      sidebarProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );

  // Refresh when configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("LocaleSynci18n")) {
        sidebarProvider.refresh();
        languageFeatures?.invalidate();
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
      watcher.onDidChange(() => {
        sidebarProvider.refresh();
        languageFeatures?.invalidate();
      });
      watcher.onDidCreate(() => {
        sidebarProvider.refresh();
        languageFeatures?.invalidate();
      });
      watcher.onDidDelete(() => {
        sidebarProvider.refresh();
        languageFeatures?.invalidate();
      });
      context.subscriptions.push(watcher);
    }
  };
  // languageFeatures is registered after watcher is defined; the closure
  // captures the binding so the assigned value is visible at trigger time.
  const languageFeatures = registerLanguageFeatures(context, i18nService, () =>
    sidebarProvider.refresh(),
  );
  registerCodeIntegrationCommands(
    context,
    i18nService,
    sidebarProvider,
    languageFeatures.invalidate,
  );

  setupWatcher();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("LocaleSynci18n.translationsPath") ||
        e.affectsConfiguration("LocaleSynci18n.defaultLanguage")
      ) {
        setupWatcher();
        languageFeatures.invalidate();
      }
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "LocaleSynci18n.configureFolder",
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
        await i18nService.setTranslationsFolder(picked[0].fsPath);
        sidebarProvider.refresh();
        setupWatcher();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("LocaleSynci18n.refresh", () =>
      sidebarProvider.refresh(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "LocaleSynci18n.translateSelection",
      () => translateSelection(i18nService, sidebarProvider),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "LocaleSynci18n.createKeyFromSelection",
      () => createKeyFromSelection(i18nService, sidebarProvider),
    ),
  );
}

export function deactivate() {}

/**
 * "Translate Selection" entry point used by the editor context menu.
 *
 * Behaviour:
 *  - If the selection is itself an existing key path (e.g.
 *    `comp.foo.title`), we tell the user the translation already exists and
 *    show every translation as choices, plus any sibling keys whose last
 *    segment matches.
 *  - Otherwise we look for keys whose VALUES match the selection, and also
 *    for keys whose last segment matches the selection's last segment, so the
 *    user can reuse an existing entry.
 *  - When the user opts to create a new key, the input is pre-filled with the
 *    selection (so dotted paths are picked up automatically).
 *  - Finally the selection is replaced with the configured key-insert
 *    template (default `${key}` — i.e. the key path only).
 */
async function translateSelection(
  i18nService: I18nService,
  sidebarProvider: SidebarProvider,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Open a file first.");
    return;
  }

  // Resolve the target range / text.
  let range: vscode.Range = editor.selection;
  let raw = editor.document.getText(range);
  if (!raw || raw.trim() === "") {
    const wordRange = editor.document.getWordRangeAtPosition(
      editor.selection.active,
      /["'`][^"'`]*["'`]/,
    );
    if (wordRange) {
      range = wordRange;
      raw = editor.document.getText(wordRange);
    }
  }
  if (!raw || raw.trim() === "") {
    vscode.window.showInformationMessage(
      "Select the text you want to translate first.",
    );
    return;
  }

  // Strip surrounding matching quotes for value comparison & default value.
  const stripped = stripQuotes(raw);
  const selection = stripped.text;

  const state = await i18nService.loadState();
  if (!state.configured) {
    vscode.window.showWarningMessage(
      "Configure your translations folder first (i18n Data Manager sidebar).",
    );
    return;
  }
  if (state.languages.length === 0) {
    vscode.window.showWarningMessage(
      "Add at least one language file first (i18n Data Manager sidebar).",
    );
    return;
  }

  const looksLikeKey = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]*$/.test(selection);
  const lastSegment = selection.includes(".")
    ? selection.split(".").pop() || selection
    : selection;

  const exactKey = state.keys.includes(selection) ? selection : undefined;
  const valueMatches = await i18nService.findKeysByValue(selection);
  const valueMatchKeys = new Set(valueMatches.map((m) => m.key));

  // Sibling keys: same last segment, different (or missing) parent path.
  const siblingKeys = looksLikeKey
    ? state.keys.filter((k) => {
        if (k === exactKey) return false;
        if (valueMatchKeys.has(k)) return false;
        const seg = k.split(".").pop();
        return seg === lastSegment;
      })
    : [];

  type Item = vscode.QuickPickItem & {
    action: "reuse" | "new";
    refKey?: string;
  };
  const items: Item[] = [];

  if (exactKey) {
    items.push({
      label: "Existing translations",
      kind: vscode.QuickPickItemKind.Separator,
      action: "reuse",
    });
    items.push(buildKeyItem(exactKey, state, "this key already exists"));
  }

  if (valueMatches.length > 0) {
    items.push({
      label: "Same value as the selection",
      kind: vscode.QuickPickItemKind.Separator,
      action: "reuse",
    });
    const seen = new Set<string>();
    for (const m of valueMatches) {
      if (m.key === exactKey) continue;
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      const it: Item = {
        label: `$(symbol-key) ${m.key}`,
        description: `${m.language}${m.exact ? "" : " (case-insensitive)"}`,
        detail: m.value,
        action: "reuse",
        refKey: m.key,
      };
      items.push(it);
    }
  }

  if (siblingKeys.length > 0) {
    items.push({
      label: `Other keys ending in ".${lastSegment}"`,
      kind: vscode.QuickPickItemKind.Separator,
      action: "reuse",
    });
    for (const k of siblingKeys) {
      items.push(buildKeyItem(k, state));
    }
  }

  items.push({
    label: "",
    kind: vscode.QuickPickItemKind.Separator,
    action: "new",
  });
  items.push({
    label: "$(add) Create new translation key…",
    description: looksLikeKey
      ? `pre-fill key with "${truncate(selection, 50)}"`
      : `use selection as source value`,
    action: "new",
  });

  const placeHolder = exactKey
    ? `"${selection}" already exists - pick an action`
    : valueMatches.length > 0 || siblingKeys.length > 0
      ? "Pick a key to reuse or create a new one"
      : "No existing key matches - create a new one";

  const picked = await vscode.window.showQuickPick<Item>(items, {
    title: `Translate: "${truncate(selection, 60)}"`,
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  let chosenKey: string | undefined;
  if (picked.action === "reuse" && picked.refKey) {
    chosenKey = picked.refKey;
  } else if (picked.action === "new") {
    chosenKey = await createKeyInteractively(i18nService, state, {
      // When the selection looks like a key, prefill the KEY input with it
      // and start with an empty source value (the user will type the actual
      // translation). Otherwise prefill the source VALUE with the selection.
      suggestedKey: looksLikeKey ? selection : "",
      suggestedValue: looksLikeKey ? "" : selection,
    });
    if (!chosenKey) return;
    sidebarProvider.refresh();
  } else {
    return;
  }

  if (!chosenKey) return;
  await insertKeyReference(editor, range, chosenKey);
}

/** Build a QuickPick item for an existing key, summarising its translations. */
function buildKeyItem(
  key: string,
  state: { languages: { code: string; flattened: Record<string, string> }[] },
  extraDescription = "",
): vscode.QuickPickItem & { action: "reuse"; refKey: string } {
  const previews: string[] = [];
  for (const lang of state.languages) {
    const v = lang.flattened[key];
    if (v) previews.push(`${lang.code}: ${truncate(v, 40)}`);
  }
  const detail = previews.length > 0 ? previews.join(" • ") : "(no values yet)";
  return {
    label: `$(symbol-key) ${key}`,
    description: extraDescription,
    detail,
    action: "reuse",
    refKey: key,
  };
}

interface AddKeyState {
  defaultLanguage: string;
  languages: { code: string }[];
  keys: string[];
  aiAvailable: boolean;
}

async function createKeyInteractively(
  i18nService: I18nService,
  state: AddKeyState,
  options: { suggestedKey: string; suggestedValue: string },
): Promise<string | undefined> {
  // 1. Ask for the new key (prefilled when the selection looks like a key path).
  const key = await vscode.window.showInputBox({
    title: "New translation key",
    prompt: "Use dots for nested keys (e.g. common.buttons.submit).",
    placeHolder: "common.buttons.submit",
    value: options.suggestedKey,
    valueSelection: options.suggestedKey
      ? [0, options.suggestedKey.length]
      : undefined,
    validateInput: (v) => {
      const t = (v || "").trim();
      if (!t) return "Key cannot be empty.";
      if (state.keys.includes(t)) return `Key "${t}" already exists.`;
      return null;
    },
  });
  if (!key) return undefined;
  const trimmedKey = key.trim();

  // 2. Ask for the source language.
  const langItems: vscode.QuickPickItem[] = state.languages.map((l) => ({
    label: l.code,
    description: l.code === state.defaultLanguage ? "(default)" : "",
  }));
  langItems.sort((a, b) =>
    a.label === state.defaultLanguage
      ? -1
      : b.label === state.defaultLanguage
        ? 1
        : 0,
  );
  const sourcePick = await vscode.window.showQuickPick(langItems, {
    title: `Source language for "${trimmedKey}"`,
    placeHolder:
      "Which language will hold the original value? (used as translation source)",
  });
  if (!sourcePick) return undefined;
  const sourceLang = sourcePick.label;

  // 3. Ask for the source value (prefilled with the selection when it isn't a key path).
  const sourceValue = await vscode.window.showInputBox({
    title: `Value for "${trimmedKey}" in ${sourceLang}`,
    prompt: "This text is what AI will translate into other languages.",
    value: options.suggestedValue,
    validateInput: (v) =>
      (v || "").trim() === "" ? "Value cannot be empty." : null,
  });
  if (sourceValue === undefined) return undefined;

  // 4. Add the key with the source value, empty values for the rest.
  const values: Record<string, string> = {};
  for (const l of state.languages) values[l.code] = "";
  values[sourceLang] = sourceValue;
  await i18nService.addKey(trimmedKey, values);

  // 5. Optionally translate to all other languages.
  if (state.aiAvailable && state.languages.length > 1) {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "Yes",
          description: `Translate "${trimmedKey}" into every other language`,
        },
        { label: "No", description: "Add the key without translating" },
      ],
      {
        title: "Auto-translate this key with AI?",
        placeHolder: "Translate to all other languages now?",
      },
    );
    if (choice && choice.label === "Yes") {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Translating "${trimmedKey}" from ${sourceLang}…`,
            cancellable: true,
          },
          async (progress, token) =>
            i18nService.translateKeyToAll(
              trimmedKey,
              sourceLang,
              { overwrite: false },
              token,
              progress,
            ),
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `i18n Data Manager: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return trimmedKey;
}

/**
 * "Create Translation Key from Selection (AI)" command.
 *
 * Uses the language model to suggest a nicely-nested key path for the
 * selected text (e.g. "Fixed the card files uploads…" → `fixes.redundantText`),
 * lets the user accept or tweak it, creates the key with the selection as the
 * source value, optionally translates it into every other language, and
 * finally replaces the selection with the configured key-insert template.
 */
async function createKeyFromSelection(
  i18nService: I18nService,
  sidebarProvider: SidebarProvider,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Open a file first.");
    return;
  }

  let range: vscode.Range = editor.selection;
  let raw = editor.document.getText(range);
  if (!raw || raw.trim() === "") {
    vscode.window.showInformationMessage(
      "Select the text you want a translation key for first.",
    );
    return;
  }
  const stripped = stripQuotes(raw);
  const valueText = stripped.text.trim();
  if (!valueText) {
    vscode.window.showInformationMessage(
      "Selection is empty after stripping quotes.",
    );
    return;
  }

  const state = await i18nService.loadState();
  if (!state.configured) {
    vscode.window.showWarningMessage(
      "Configure your translations folder first (i18n Data Manager sidebar).",
    );
    return;
  }
  if (state.languages.length === 0) {
    vscode.window.showWarningMessage(
      "Add at least one language file first (i18n Data Manager sidebar).",
    );
    return;
  }
  if (!state.aiAvailable) {
    vscode.window.showWarningMessage(
      "AI is not available. Install GitHub Copilot (or another VS Code language model provider) and try again.",
    );
    return;
  }

  // Pick the source language up-front (default is recommended).
  const langItems: vscode.QuickPickItem[] = state.languages.map((l) => ({
    label: l.code,
    description: l.code === state.defaultLanguage ? "(default)" : "",
  }));
  langItems.sort((a, b) =>
    a.label === state.defaultLanguage
      ? -1
      : b.label === state.defaultLanguage
        ? 1
        : 0,
  );
  const sourcePick = await vscode.window.showQuickPick(langItems, {
    title: "Source language for the selected text",
    placeHolder:
      "Which language is the selected text written in? (used as translation source)",
  });
  if (!sourcePick) return;
  const sourceLang = sourcePick.label;

  // Ask the model for a key suggestion.
  let suggestion: string;
  try {
    suggestion = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Asking AI for a key suggestion…",
        cancellable: true,
      },
      (_progress, token) =>
        i18nService.suggestKeyPath(
          valueText,
          { existingKeys: state.keys, sourceLang },
          token,
        ),
    );
  } catch (e) {
    vscode.window.showErrorMessage(
      `i18n Data Manager: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // Avoid clashes with existing keys by appending a numeric suffix.
  let unique = suggestion;
  if (state.keys.includes(unique)) {
    let i = 2;
    while (state.keys.includes(`${suggestion}${i}`)) i++;
    unique = `${suggestion}${i}`;
  }

  // Let the user confirm / edit the proposed key.
  const finalKey = await vscode.window.showInputBox({
    title: "AI-suggested translation key",
    prompt: "Edit the key if you want, then press Enter.",
    value: unique,
    valueSelection: [unique.lastIndexOf(".") + 1, unique.length],
    validateInput: (v) => {
      const t = (v || "").trim();
      if (!t) return "Key cannot be empty.";
      if (!/^[A-Za-z0-9_$][A-Za-z0-9_$.]*$/.test(t)) {
        return "Use dot notation with letters, digits, _ and $ only.";
      }
      if (state.keys.includes(t)) return `Key "${t}" already exists.`;
      return null;
    },
  });
  if (!finalKey) return;
  const trimmedKey = finalKey.trim();

  // Create the key with the source value.
  const values: Record<string, string> = {};
  for (const l of state.languages) values[l.code] = "";
  values[sourceLang] = valueText;
  await i18nService.addKey(trimmedKey, values);

  // Translate to all other languages (no second prompt — the user already
  // opted into the AI flow by choosing this command).
  if (state.languages.length > 1) {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Translating "${trimmedKey}" from ${sourceLang}…`,
          cancellable: true,
        },
        (progress, token) =>
          i18nService.translateKeyToAll(
            trimmedKey,
            sourceLang,
            { overwrite: false },
            token,
            progress,
          ),
      );
    } catch (e) {
      vscode.window.showErrorMessage(
        `i18n Data Manager: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  sidebarProvider.refresh();
  await insertKeyReference(editor, range, trimmedKey);
  vscode.window.setStatusBarMessage(
    `i18n: created "${trimmedKey}" from selection`,
    3000,
  );
}

async function insertKeyReference(
  editor: vscode.TextEditor,
  range: vscode.Range,
  key: string,
): Promise<void> {
  const template =
    vscode.workspace
      .getConfiguration("LocaleSynci18n")
      .get<string>("keyInsertTemplate") || "${key}";
  const replacement = template.replace(/\$\{key\}/g, key);
  await editor.edit((edit) => edit.replace(range, replacement));
}

function stripQuotes(s: string): { text: string; quote: string | "" } {
  const m = s.match(/^(['"`])([\s\S]*)\1$/);
  if (m) return { text: m[2], quote: m[1] };
  return { text: s, quote: "" };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
