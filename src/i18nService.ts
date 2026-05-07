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

  /**
   * Ask the language model to suggest a nicely-nested dot-notation key for an
   * arbitrary piece of source text. The model is instructed to return ONE
   * key in `group.subgroup.shortName` form using lowerCamelCase segments.
   *
   * Existing top-level groups are passed in so the model can reuse them when
   * a sensible group already exists (e.g. `errors.*`, `buttons.*`).
   */
  async suggestKeyPath(
    text: string,
    options: { existingKeys: string[]; sourceLang?: string },
    token?: vscode.CancellationToken,
  ): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Text cannot be empty.");

    // Collect a small sample of existing top-level groups (max 30) to guide
    // the model toward consistency without bloating the prompt.
    const groups = new Set<string>();
    for (const k of options.existingKeys) {
      const dot = k.indexOf(".");
      if (dot > 0) groups.add(k.slice(0, dot));
    }
    const groupList = Array.from(groups).slice(0, 30);

    const prompt =
      `You are naming an i18n translation key for a piece of UI text.\n\n` +
      `Text${options.sourceLang ? ` (in "${options.sourceLang}")` : ""}:\n` +
      `"""\n${trimmed}\n"""\n\n` +
      (groupList.length > 0
        ? `Existing top-level groups in this project (reuse one when it fits):\n${groupList.join(", ")}\n\n`
        : "") +
      `Rules:\n` +
      `- Return ONE key path only. No explanation, no quotes, no code fences.\n` +
      `- Use dot notation: \`group.subgroup.shortName\` (2 to 4 segments).\n` +
      `- Each segment is lowerCamelCase, ASCII letters/digits only, no spaces, no symbols.\n` +
      `- Pick a group that describes WHAT the text is (e.g. \`errors\`, \`buttons\`, \`fixes\`, \`labels\`, \`messages\`, \`titles\`).\n` +
      `- The last segment should be a short, descriptive camelCase name derived from the text's MEANING (not a verbatim copy).\n` +
      `- Keep the whole key under 60 characters.\n` +
      `- Reuse one of the existing groups above when it fits semantically.\n\n` +
      `Reply with the key path only.`;

    const model = await this.getChatModel();
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const cancel = token ?? new vscode.CancellationTokenSource().token;

    let raw = "";
    try {
      const response = await model.sendRequest(messages, {}, cancel);
      for await (const chunk of response.text) raw += chunk;
    } catch (e) {
      if (e instanceof vscode.LanguageModelError) {
        throw new Error(`Language model error: ${e.message}`);
      }
      throw e;
    }

    return this.sanitizeKeyPath(raw);
  }

  /** Normalise a key path returned by the model into safe dot notation. */
  sanitizeKeyPath(raw: string): string {
    let s = (raw || "").trim();
    // Strip code fences / backticks / surrounding quotes.
    s = s.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
    s = s.replace(/^[`'"]+|[`'"]+$/g, "").trim();
    // Take first non-empty line in case the model added commentary.
    const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
    s = firstLine;
    // Drop common prefixes like "Key:" or "key =".
    s = s.replace(/^key\s*[:=]\s*/i, "").trim();
    // Sanitise each segment.
    const segments = s
      .split(".")
      .map((seg) =>
        seg
          .replace(/[^A-Za-z0-9_$]/g, "")
          .replace(/^[0-9]+/, ""),
      )
      .filter(Boolean);
    if (segments.length === 0) {
      throw new Error("Could not derive a valid key path from the AI reply.");
    }
    let key = segments.join(".");
    if (key.length > 80) key = key.slice(0, 80);
    return key;
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
  ): Promise<{ translated: number; skipped: number }> {    const state = await this.loadState();
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

  /**
   * Translate every key in the target language file from the source language.
   * Used when creating a new language file with "Auto-translate" enabled.
   *
   * Sends values in BATCHES (one prompt per chunk) instead of one request per
   * key, which is dramatically faster. If the model's batched response can't
   * be parsed, we fall back to per-key translation for that chunk so a single
   * malformed reply never aborts the whole job.
   */
  async translateLanguageFile(
    targetLang: string,
    sourceLang: string,
    options: { overwrite: boolean },
    token?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<{ translated: number; skipped: number; failed: number }> {
    if (sourceLang === targetLang) {
      throw new Error("Source and target languages must differ.");
    }
    const state = await this.loadState();
    const source = state.languages.find((l) => l.code === sourceLang);
    const target = state.languages.find((l) => l.code === targetLang);
    if (!source) throw new Error(`Source language "${sourceLang}" not found.`);
    if (!target) throw new Error(`Target language "${targetLang}" not found.`);

    const next = { ...target.flattened };
    const todo: Array<{ key: string; value: string }> = [];
    let skipped = 0;

    for (const [key, value] of Object.entries(source.flattened)) {
      const sourceValue = value ?? "";
      if (sourceValue.trim() === "") {
        next[key] = "";
        skipped++;
        continue;
      }
      const existing = next[key];
      if (!options.overwrite && existing && existing.trim() !== "") {
        skipped++;
        continue;
      }
      todo.push({ key, value: sourceValue });
    }

    const total = Math.max(todo.length, 1);
    const totalKeys = todo.length;
    const step = 100 / total;

    // Heuristic chunking: ~50 entries OR ~6000 source chars per request,
    // whichever comes first. Keeps each prompt well below typical context
    // limits while still cutting round-trips by 1-2 orders of magnitude.
    const MAX_ITEMS = 50;
    const MAX_CHARS = 6000;
    const chunks: Array<Array<{ key: string; value: string }>> = [];
    let cur: Array<{ key: string; value: string }> = [];
    let curChars = 0;
    for (const entry of todo) {
      const len = entry.key.length + entry.value.length + 8;
      if (cur.length >= MAX_ITEMS || (cur.length > 0 && curChars + len > MAX_CHARS)) {
        chunks.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(entry);
      curChars += len;
    }
    if (cur.length > 0) chunks.push(cur);

    let translated = 0;
    let failed = 0;
    let processed = 0;

    for (let i = 0; i < chunks.length; i++) {
      if (token?.isCancellationRequested) break;
      const chunk = chunks[i];
      progress?.report({
        message: `batch ${i + 1}/${chunks.length} (${chunk.length} keys)`,
      });

      const results = await this.translateBatch(
        chunk,
        sourceLang,
        targetLang,
        token,
      );

      for (let j = 0; j < chunk.length; j++) {
        const { key, value } = chunk[j];
        const out = results[j];
        if (typeof out === "string") {
          next[key] = out;
          translated++;
        } else {
          // Per-key fallback for this single entry.
          try {
            next[key] = await this.runTranslation(
              value,
              sourceLang,
              targetLang,
              token,
            );
            translated++;
          } catch (e) {
            failed++;
            process.stderr.write(
              `i18n Data Manager: failed to translate "${key}" → ${targetLang}: ${
                e instanceof Error ? e.message : String(e)
              }\n`,
            );
          }
        }
        processed++;
        progress?.report({ increment: step });
      }
    }

    // If we were cancelled mid-way, still account for unprocessed keys in the
    // returned counts so the caller can show an accurate summary.
    if (processed < totalKeys) {
      // do not write null entries; leave existing target values untouched.
    }

    await this.writeLanguage(target.filePath, next);
    return { translated, skipped, failed };
  }

  /**
   * Translate an array of {key,value} pairs in a single language model call.
   * Returns an array aligned with `entries`, where each slot is either the
   * translated string or `undefined` when the model omitted/garbled that key
   * (the caller is expected to fall back to a per-key translation in that
   * case).
   */
  private async translateBatch(
    entries: Array<{ key: string; value: string }>,
    sourceLang: string,
    targetLang: string,
    token?: vscode.CancellationToken,
  ): Promise<Array<string | undefined>> {
    if (entries.length === 0) return [];
    if (entries.length === 1) {
      try {
        const out = await this.runTranslation(
          entries[0].value,
          sourceLang,
          targetLang,
          token,
        );
        return [out];
      } catch {
        return [undefined];
      }
    }

    // Build a numbered map so the model can't accidentally collide on dotted
    // keys, then translate back to the caller-visible keys.
    const idMap: Record<string, { key: string; value: string }> = {};
    const payload: Record<string, string> = {};
    entries.forEach((e, idx) => {
      const id = `t${idx}`;
      idMap[id] = e;
      payload[id] = e.value;
    });

    const prompt =
      `You are a professional software localization translator.\n` +
      `Translate every value in the JSON object below from "${sourceLang}" to "${targetLang}".\n\n` +
      `Strict rules:\n` +
      `- Reply with ONLY a single JSON object, no markdown fences, no commentary.\n` +
      `- The reply MUST have the EXACT same keys as the input (do not add, remove, rename, or reorder them).\n` +
      `- Translate ONLY the values. Do NOT translate the keys.\n` +
      `- Preserve placeholders exactly: {name}, {{count}}, %s, %d, $1, :param, ICU plural/select, etc.\n` +
      `- Preserve HTML tags, attributes, entities, and ICU MessageFormat constructs.\n` +
      `- Preserve leading/trailing whitespace, line breaks, and punctuation style.\n` +
      `- Do not translate placeholder names or variable identifiers.\n` +
      `- If a value is empty, return an empty string for that key.\n\n` +
      `Input JSON:\n` +
      JSON.stringify(payload, null, 2);

    let raw = "";
    try {
      const model = await this.getChatModel();
      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const cancel = token ?? new vscode.CancellationTokenSource().token;
      const response = await model.sendRequest(messages, {}, cancel);
      for await (const chunk of response.text) raw += chunk;
    } catch (e) {
      process.stderr.write(
        `i18n Data Manager: batch translate request failed: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
      return entries.map(() => undefined);
    }

    const parsed = this.parseBatchJson(raw);
    if (!parsed) {
      return entries.map(() => undefined);
    }

    return entries.map((_, idx) => {
      const id = `t${idx}`;
      const v = parsed[id];
      return typeof v === "string" ? v : undefined;
    });
  }

  /**
   * Best-effort JSON extraction from a model reply. Strips ```json fences and
   * trims any preamble/epilogue around the first balanced `{...}` block.
   */
  private parseBatchJson(text: string): Record<string, unknown> | undefined {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return undefined;
    const slice = cleaned.slice(start, end + 1);
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Find existing keys whose value (in any language) matches the given text.
   * Returns matches sorted: exact case-sensitive first, then case-insensitive.
   */
  async findKeysByValue(
    text: string,
  ): Promise<Array<{ key: string; language: string; value: string; exact: boolean }>> {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const lower = trimmed.toLowerCase();
    const state = await this.loadState();
    const matches: Array<{ key: string; language: string; value: string; exact: boolean }> = [];
    const seen = new Set<string>();
    for (const lang of state.languages) {
      for (const [k, v] of Object.entries(lang.flattened)) {
        if (!v) continue;
        const vTrim = v.trim();
        if (vTrim === trimmed || vTrim.toLowerCase() === lower) {
          const id = `${k}::${lang.code}`;
          if (seen.has(id)) continue;
          seen.add(id);
          matches.push({
            key: k,
            language: lang.code,
            value: v,
            exact: vTrim === trimmed,
          });
        }
      }
    }
    matches.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return a.key.localeCompare(b.key);
    });
    return matches;
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
