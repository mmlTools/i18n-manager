import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface LanguageData {
  code: string;
  filePath: string;
  flattened: Record<string, string>;
}

export interface I18nState {
  configured: boolean;
  folderPath: string;
  folderDisplay: string;
  languages: LanguageData[];
  keys: string[];
  defaultLanguage: string;
  /** True only when the user has both opted in (setting) AND a language model is reachable. */
  aiAvailable: boolean;
}

export class I18nService {
  resolveFolderPath(): string | undefined {
    const config = vscode.workspace.getConfiguration("LocaleSynci18n");
    const setting = (config.get<string>("translationsPath") || "").trim();
    if (!setting) return undefined;
    if (path.isAbsolute(setting)) return setting;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;
    return path.join(ws.uri.fsPath, setting);
  }

  getDefaultLanguage(): string {
    return (
      vscode.workspace
        .getConfiguration("LocaleSynci18n")
        .get<string>("defaultLanguage") || "en"
    );
  }

  getIndent(): number {
    const n = vscode.workspace
      .getConfiguration("LocaleSynci18n")
      .get<number>("indent");
    return typeof n === "number" && n >= 0 ? n : 2;
  }

  // ─── AI / Language Model ────────────────────────────────────

  /**
   * Whether the user has opted in via the setting AND at least one chat model
   * is reachable through the VS Code Language Model API. Always returns false
   * (never throws) when the API or any provider is missing the rest of the
   * extension is unaffected.
   */
  async isLanguageModelAvailable(): Promise<boolean> {
    const enabled = vscode.workspace
      .getConfiguration("LocaleSynci18n")
      .get<boolean>("aiTranslate.enabled", true);
    if (!enabled) return false;
    try {
      // Defensive: feature-detect the API at runtime as well as compile time.
      const lm = (vscode as { lm?: typeof vscode.lm }).lm;
      if (!lm || typeof lm.selectChatModels !== "function") return false;
      const models = await lm.selectChatModels();
      return Array.isArray(models) && models.length > 0;
    } catch {
      return false;
    }
  }

  private async getChatModel(): Promise<vscode.LanguageModelChat> {
    const lm = (vscode as { lm?: typeof vscode.lm }).lm;
    if (!lm || typeof lm.selectChatModels !== "function") {
      throw new Error(
        "AI translation needs a VS Code language model provider. Install GitHub Copilot (or another LM provider) and sign in.",
      );
    }
    const models = await lm.selectChatModels();
    if (!models || models.length === 0) {
      throw new Error(
        "No language model is currently available. If you have GitHub Copilot, make sure it is enabled and signed in.",
      );
    }
    return models[0];
  }

  private buildPrompt(
    text: string,
    sourceLang: string,
    targetLang: string,
  ): string {
    return (
      `You are a professional software localization translator.\n` +
      `Translate the text below from "${sourceLang}" to "${targetLang}".\n\n` +
      `Strict rules:\n` +
      `- Reply with ONLY the translated text. No quotes, no preamble, no explanation.\n` +
      `- Preserve placeholders exactly as written: {name}, {{count}}, %s, %d, $1, :param, etc.\n` +
      `- Preserve HTML tags, attributes, and entities exactly.\n` +
      `- Preserve ICU MessageFormat constructs (plural, select, selectordinal).\n` +
      `- Preserve leading/trailing whitespace, line breaks, and punctuation style.\n` +
      `- Do not translate placeholder names or variable identifiers.\n\n` +
      `Text:\n${text}`
    );
  }

  private async runTranslation(
    text: string,
    sourceLang: string,
    targetLang: string,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    const model = await this.getChatModel();
    const messages = [
      vscode.LanguageModelChatMessage.User(
        this.buildPrompt(text, sourceLang, targetLang),
      ),
    ];
    const cancel = token ?? new vscode.CancellationTokenSource().token;
    try {
      const response = await model.sendRequest(messages, {}, cancel);
      let out = "";
      for await (const chunk of response.text) out += chunk;
      // Strip surrounding quotes the model occasionally adds despite instructions.
      return out.trim().replace(/^["'`]+|["'`]+$/g, "");
    } catch (e) {
      if (e instanceof vscode.LanguageModelError) {
        if (e.code === "NoPermissions") {
          throw new Error(
            "Permission to use the language model was not granted. Run the command again and accept the consent prompt.",
          );
        }
        if (e.code === "Blocked") {
          throw new Error(
            "The language model declined this request (content filter).",
          );
        }
        throw new Error(`Language model error: ${e.message}`);
      }
      throw e;
    }
  }

  async translateValue(
    key: string,
    sourceLang: string,
    targetLang: string,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    if (sourceLang === targetLang) {
      throw new Error("Source and target languages must differ.");
    }
    const state = await this.loadState();
    const source = state.languages.find((l) => l.code === sourceLang);
    const target = state.languages.find((l) => l.code === targetLang);
    if (!source) throw new Error(`Source language "${sourceLang}" not found.`);
    if (!target) throw new Error(`Target language "${targetLang}" not found.`);
    const sourceValue = source.flattened[key] ?? "";
    if (sourceValue.trim() === "") {
      throw new Error(
        `Source value for "${key}" in "${sourceLang}" is empty. Fill it in first or pick a different source language.`,
      );
    }
    const translation = await this.runTranslation(
      sourceValue,
      sourceLang,
      targetLang,
      token,
    );
    const next = { ...target.flattened };
    next[key] = translation;
    await this.writeLanguage(target.filePath, next);
    return translation;
  }

  async translateKeyToAll(
    key: string,
    sourceLang: string,
    options: { overwrite: boolean },
    token?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<{ translated: number; skipped: number }> {
    const state = await this.loadState();
    const source = state.languages.find((l) => l.code === sourceLang);
    if (!source) throw new Error(`Source language "${sourceLang}" not found.`);
    const sourceValue = source.flattened[key] ?? "";
    if (sourceValue.trim() === "") {
      throw new Error(
        `Source value for "${key}" in "${sourceLang}" is empty. Fill it in first or pick a different source language.`,
      );
    }
    const targets = state.languages.filter((l) => l.code !== sourceLang);
    const total = Math.max(targets.length, 1);
    const step = 100 / total;

    let translated = 0;
    let skipped = 0;
    for (const target of targets) {
      if (token?.isCancellationRequested) break;
      const existing = target.flattened[key];
      if (!options.overwrite && existing && existing.trim() !== "") {
        skipped++;
        progress?.report({
          message: `skipped ${target.code}`,
          increment: step,
        });
        continue;
      }
      progress?.report({ message: `→ ${target.code}` });
      const translation = await this.runTranslation(
        sourceValue,
        sourceLang,
        target.code,
        token,
      );
      const next = { ...target.flattened };
      next[key] = translation;
      await this.writeLanguage(target.filePath, next);
      translated++;
      progress?.report({ increment: step });
    }
    return { translated, skipped };
  }

  // ─── State loading ──────────────────────────────────────────

  async loadState(): Promise<I18nState> {
    const defaultLanguage = this.getDefaultLanguage();
    const folderPath = this.resolveFolderPath();
    const aiAvailable = await this.isLanguageModelAvailable();

    if (!folderPath) {
      return {
        configured: false,
        folderPath: "",
        folderDisplay: "",
        languages: [],
        keys: [],
        defaultLanguage,
        aiAvailable,
      };
    }

    let exists = false;
    try {
      const stat = await fs.stat(folderPath);
      exists = stat.isDirectory();
    } catch {
      exists = false;
    }

    const folderDisplay = this.toDisplayPath(folderPath);

    if (!exists) {
      return {
        configured: false,
        folderPath,
        folderDisplay,
        languages: [],
        keys: [],
        defaultLanguage,
        aiAvailable,
      };
    }

    const files = await fs.readdir(folderPath);
    const languages: LanguageData[] = [];

    for (const file of files) {
      if (!file.toLowerCase().endsWith(".json")) continue;
      const filePath = path.join(folderPath, file);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        const content = await fs.readFile(filePath, "utf-8");
        const trimmed = content.trim();
        const data = trimmed.length === 0 ? {} : JSON.parse(trimmed);
        languages.push({
          code: file.replace(/\.json$/i, ""),
          filePath,
          flattened: this.flatten(data),
        });
      } catch (e) {
        process.stderr.write(
          `i18n Data Manager: failed to read ${file}: ${
            e instanceof Error ? (e.stack ?? e.message) : String(e)
          }\n`,
        );
      }
    }

    languages.sort((a, b) => {
      if (a.code === defaultLanguage) return -1;
      if (b.code === defaultLanguage) return 1;
      return a.code.localeCompare(b.code);
    });

    const keysSet = new Set<string>();
    for (const lang of languages) {
      for (const k of Object.keys(lang.flattened)) keysSet.add(k);
    }

    return {
      configured: true,
      folderPath,
      folderDisplay,
      languages,
      keys: Array.from(keysSet).sort(),
      defaultLanguage,
      aiAvailable,
    };
  }

  private toDisplayPath(absolute: string): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws && absolute.startsWith(ws.uri.fsPath)) {
      const rel = path.relative(ws.uri.fsPath, absolute);
      return rel === "" ? "." : rel;
    }
    return absolute;
  }

  flatten(obj: unknown, prefix = ""): Record<string, string> {
    const result: Record<string, string> = {};
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return result;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(result, this.flatten(value, newKey));
      } else if (value === null || value === undefined) {
        result[newKey] = "";
      } else {
        result[newKey] = String(value);
      }
    }
    return result;
  }

  unflatten(flat: Record<string, string>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const sortedKeys = Object.keys(flat).sort();
    for (const key of sortedKeys) {
      const parts = key.split(".");
      let cur: Record<string, unknown> = result;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        const existing = cur[p];
        if (
          !existing ||
          typeof existing !== "object" ||
          Array.isArray(existing)
        ) {
          cur[p] = {};
        }
        cur = cur[p] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = flat[key];
    }
    return result;
  }

  async writeLanguage(
    filePath: string,
    flat: Record<string, string>,
  ): Promise<void> {
    const nested = this.unflatten(flat);
    const indent = this.getIndent();
    const json = JSON.stringify(nested, null, indent);
    await fs.writeFile(filePath, json + "\n", "utf-8");
  }

  async addKey(key: string, values: Record<string, string>): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("Key cannot be empty.");
    const state = await this.loadState();
    if (state.languages.length === 0)
      throw new Error("No language files found. Create one first.");
    for (const lang of state.languages) {
      const next = { ...lang.flattened };
      next[trimmed] = values[lang.code] ?? "";
      await this.writeLanguage(lang.filePath, next);
    }
  }

  async updateValue(
    key: string,
    languageCode: string,
    value: string,
  ): Promise<void> {
    const state = await this.loadState();
    const lang = state.languages.find((l) => l.code === languageCode);
    if (!lang) throw new Error(`Language "${languageCode}" not found.`);
    const next = { ...lang.flattened };
    next[key] = value;
    await this.writeLanguage(lang.filePath, next);
  }

  async deleteKey(key: string): Promise<void> {
    const state = await this.loadState();
    for (const lang of state.languages) {
      if (key in lang.flattened) {
        const next = { ...lang.flattened };
        delete next[key];
        await this.writeLanguage(lang.filePath, next);
      }
    }
  }

  async renameKey(oldKey: string, newKey: string): Promise<void> {
    const trimmed = newKey.trim();
    if (!trimmed) throw new Error("New key cannot be empty.");
    if (trimmed === oldKey) return;
    const state = await this.loadState();
    for (const lang of state.languages) {
      const next = { ...lang.flattened };
      if (oldKey in next) {
        next[trimmed] = next[oldKey];
        delete next[oldKey];
        await this.writeLanguage(lang.filePath, next);
      }
    }
  }

  async addLanguage(code: string, copyFrom?: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) throw new Error("Language code cannot be empty.");
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      throw new Error(
        "Language code may only contain letters, numbers, hyphens and underscores.",
      );
    }
    const state = await this.loadState();
    const folder = state.folderPath;
    if (!folder) throw new Error("No translations folder is configured.");
    const filePath = path.join(folder, `${trimmed}.json`);

    try {
      await fs.access(filePath);
      throw new Error(`Language "${trimmed}" already exists.`);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }

    const data: Record<string, string> = {};
    const source =
      (copyFrom && state.languages.find((l) => l.code === copyFrom)) ||
      state.languages.find((l) => l.code === state.defaultLanguage) ||
      state.languages[0];
    if (source) {
      for (const k of Object.keys(source.flattened)) data[k] = "";
    }
    await this.writeLanguage(filePath, data);
  }

  async deleteLanguage(code: string): Promise<void> {
    const state = await this.loadState();
    const lang = state.languages.find((l) => l.code === code);
    if (!lang) throw new Error(`Language "${code}" not found.`);
    await fs.unlink(lang.filePath);
  }

  async syncMissingKeys(): Promise<number> {
    const state = await this.loadState();
    let writes = 0;
    for (const lang of state.languages) {
      let changed = false;
      const next = { ...lang.flattened };
      for (const k of state.keys) {
        if (!(k in next)) {
          next[k] = "";
          changed = true;
        }
      }
      if (changed) {
        await this.writeLanguage(lang.filePath, next);
        writes++;
      }
    }
    return writes;
  }
}
