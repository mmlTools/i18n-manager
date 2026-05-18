import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface LanguageData {
  code: string;
  /**
   * For `json`/`ini` formats: absolute path of the single translation file.
   * For `php` (CodeIgniter 4) format: absolute path of the locale DIRECTORY
   * (e.g. `app/Language/en`), which contains one `*.php` group file per
   * top-level namespace (`Messages.php`, `Buttons.php`, ...).
   */
  filePath: string;
  format: TranslationFormat;
  flattened: Record<string, string>;
  /**
   * For `php` format only: filenames (with `.php`) of the group files that
   * existed on disk for this locale. Tracked so we can delete group files
   * that become empty after a write.
   */
  groupFiles?: string[];
}

export type TranslationFormat = "json" | "ini" | "php";

/**
 * A workspace folder that *looks* like a translations folder — it contains
 * one or more files whose names match common locale patterns (`en.json`,
 * `en_US.ini`, `en-US.json`, …). Surfaced in the empty state so the user
 * can one-click instead of digging through the file picker.
 */
export interface FolderSuggestion {
  /** Absolute path on disk. */
  folderPath: string;
  /** Path relative to the workspace root, or absolute when outside it. */
  display: string;
  /** Sample of locale codes detected inside (max 6). */
  sampleLocales: string[];
  /** Total number of locale-named translation files in the folder. */
  fileCount: number;
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
  /**
   * When `configured` is false, candidate folders detected in the workspace
   * that look like they hold translation files (`en.json`, `en-US.ini`, …).
   * Empty otherwise.
   */
  folderSuggestions: FolderSuggestion[];
}

export class I18nService {
  private static readonly SUPPORTED_EXTENSIONS = [".json", ".ini"] as const;
  /** CodeIgniter 4 group filenames are valid PHP identifiers (e.g. `Messages.php`). */
  private static readonly CI4_GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    await this.writeLanguage(target.filePath, next, {
      format: target.format,
      previousGroupFiles: target.groupFiles,
    });
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
      await this.writeLanguage(target.filePath, next, {
        format: target.format,
        previousGroupFiles: target.groupFiles,
      });
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

    await this.writeLanguage(target.filePath, next, {
      format: target.format,
      previousGroupFiles: target.groupFiles,
    });
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

  // ─── Folder discovery ───────────────────────────────────────

  /**
   * Match locale-style filenames (without extension):
   *   en, en_US, en-US, en_us, zh-Hans, pt_BR, sr-Latn-RS, …
   * Two- or three-letter language code, optionally followed by `-`/`_`
   * separated region/script subtags (each 2-4 alphanum chars).
   */
  private static readonly LOCALE_NAME = /^[a-z]{2,3}(?:[-_][a-zA-Z0-9]{2,4}){0,3}$/i;

  /**
   * Scan the workspace for folders that look like they hold translation
   * .json/.ini files and return them ranked by likelihood.
   *
   * Heuristic: a folder qualifies when at least one direct-child translation
   * file has a locale-style name (`en.json`, `en-US.ini`, `zh-Hans.json`, …).
   * The scan honours `files.exclude`/`search.exclude` and skips heavy
   * directories (node_modules, dist, build, .next, .git, …).
   *
   * Returns at most 10 suggestions, ranked by:
   *   1. number of locale files (descending),
   *   2. shorter relative path (closer to root wins),
   *   3. alphabetical.
   */
  async findCandidateFolders(): Promise<FolderSuggestion[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return [];

    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        "**/*.{json,ini,php}",
        "**/{node_modules,out,dist,build,.next,.nuxt,coverage,.git,.svn,.hg,.idea,.vscode-test,.cache,vendor,target,bin,obj}/**",
        4000,
      );
    } catch {
      return [];
    }

    // Group locale-named translation files by their parent folder.
    const groups = new Map<string, string[]>();
    // Track CI4 layouts: `Language/<locale>/<Group>.php` →
    // parent (`Language`) → set of locale subdir names.
    const ci4Groups = new Map<string, Set<string>>();
    for (const uri of uris) {
      if (uri.scheme !== "file") continue;
      const file = path.basename(uri.fsPath);
      const ext = path.extname(file).toLowerCase();
      if (ext === ".php") {
        // CI4: parent folder is the locale, grandparent is the Language root.
        const localeDir = path.dirname(uri.fsPath);
        const localeName = path.basename(localeDir);
        if (!I18nService.LOCALE_NAME.test(localeName)) continue;
        const groupName = path.basename(file, ".php");
        if (!I18nService.CI4_GROUP_NAME.test(groupName)) continue;
        const langRoot = path.dirname(localeDir);
        const set = ci4Groups.get(langRoot) ?? new Set<string>();
        set.add(localeName);
        ci4Groups.set(langRoot, set);
        continue;
      }
      if (!I18nService.isSupportedExtension(ext)) continue;
      const stem = path.basename(file, ext);
      if (!I18nService.LOCALE_NAME.test(stem)) continue;
      const dir = path.dirname(uri.fsPath);
      const list = groups.get(dir) ?? [];
      list.push(stem);
      groups.set(dir, list);
    }

    if (groups.size === 0 && ci4Groups.size === 0) return [];

    const wsRoot = ws.uri.fsPath;
    const suggestions: FolderSuggestion[] = [];
    for (const [folderPath, locales] of groups) {
      // De-dup case-insensitively but preserve original casing of the first occurrence.
      const seen = new Set<string>();
      const uniqueLocales: string[] = [];
      for (const l of locales) {
        const key = l.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueLocales.push(l);
      }
      uniqueLocales.sort((a, b) => a.localeCompare(b));
      const display = this.toDisplayPath(folderPath);
      suggestions.push({
        folderPath,
        display: display === "" ? "." : display,
        sampleLocales: uniqueLocales.slice(0, 6),
        fileCount: uniqueLocales.length,
      });
    }

    // CodeIgniter 4 candidate folders: each locale appears as a subdirectory.
    for (const [folderPath, localeSet] of ci4Groups) {
      // Avoid duplicating a folder we already added as a flat suggestion.
      if (groups.has(folderPath)) continue;
      const uniqueLocales = Array.from(localeSet).sort((a, b) =>
        a.localeCompare(b),
      );
      const display = this.toDisplayPath(folderPath);
      suggestions.push({
        folderPath,
        display: display === "" ? "." : display,
        sampleLocales: uniqueLocales.slice(0, 6),
        fileCount: uniqueLocales.length,
      });
    }

    suggestions.sort((a, b) => {
      if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
      const aRel = path.relative(wsRoot, a.folderPath);
      const bRel = path.relative(wsRoot, b.folderPath);
      const aDepth = aRel.split(path.sep).filter(Boolean).length;
      const bDepth = bRel.split(path.sep).filter(Boolean).length;
      if (aDepth !== bDepth) return aDepth - bDepth;
      return a.display.localeCompare(b.display);
    });

    return suggestions.slice(0, 10);
  }

  /**
   * Persist a chosen folder to the workspace configuration. Stores a
   * workspace-relative path when the folder lives inside the workspace,
   * otherwise the absolute path.
   */
  async setTranslationsFolder(folderPath: string): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    let toSave = folderPath;
    if (ws) {
      const wsPath = ws.uri.fsPath;
      if (folderPath === wsPath || folderPath.startsWith(wsPath + path.sep)) {
        toSave = path.relative(wsPath, folderPath) || ".";
      }
    }
    await vscode.workspace
      .getConfiguration("LocaleSynci18n")
      .update(
        "translationsPath",
        toSave,
        vscode.ConfigurationTarget.Workspace,
      );
  }

  // ─── State loading ──────────────────────────────────────────

  async loadState(): Promise<I18nState> {
    const defaultLanguage = this.getDefaultLanguage();
    const folderPath = this.resolveFolderPath();
    const aiAvailable = await this.isLanguageModelAvailable();

    if (!folderPath) {
      const folderSuggestions = await this.findCandidateFolders();
      return {
        configured: false,
        folderPath: "",
        folderDisplay: "",
        languages: [],
        keys: [],
        defaultLanguage,
        aiAvailable,
        folderSuggestions,
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
      const folderSuggestions = await this.findCandidateFolders();
      return {
        configured: false,
        folderPath,
        folderDisplay,
        languages: [],
        keys: [],
        defaultLanguage,
        aiAvailable,
        folderSuggestions,
      };
    }

    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const languages: LanguageData[] = [];

    // Detect CodeIgniter 4 layout: `<folder>/<locale>/<Group>.php`. The locale
    // is the subdirectory name; group files live one level deep. Activated
    // when at least one locale-named subdirectory contains a `.php` file AND
    // no flat-file translations are present at the root (we prefer flat mode
    // when both shapes are mixed so existing setups keep working).
    const hasFlatFiles = entries.some((e) => {
      if (!e.isFile()) return false;
      return I18nService.isSupportedExtension(path.extname(e.name).toLowerCase());
    });
    if (!hasFlatFiles) {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const locale = entry.name;
        if (!I18nService.LOCALE_NAME.test(locale)) continue;
        const localeDir = path.join(folderPath, locale);
        let phpFiles: string[];
        try {
          phpFiles = (await fs.readdir(localeDir)).filter(
            (f) => path.extname(f).toLowerCase() === ".php",
          );
        } catch {
          continue;
        }
        if (phpFiles.length === 0) continue;
        const flattened: Record<string, string> = {};
        for (const groupFile of phpFiles) {
          const groupName = path.basename(groupFile, ".php");
          if (!I18nService.CI4_GROUP_NAME.test(groupName)) continue;
          const filePath = path.join(localeDir, groupFile);
          try {
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = this.parsePhpLangFile(content);
            const flat = this.flatten(parsed);
            for (const [k, v] of Object.entries(flat)) {
              flattened[`${groupName}.${k}`] = v;
            }
          } catch (e) {
            process.stderr.write(
              `i18n Data Manager: failed to read ${path.join(locale, groupFile)}: ${
                e instanceof Error ? (e.stack ?? e.message) : String(e)
              }\n`,
            );
          }
        }
        languages.push({
          code: locale,
          filePath: localeDir,
          format: "php",
          flattened,
          groupFiles: phpFiles,
        });
      }
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = entry.name;
      const ext = path.extname(file).toLowerCase();
      if (!I18nService.isSupportedExtension(ext)) continue;
      const filePath = path.join(folderPath, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const format = ext === ".ini" ? "ini" : "json";
        const data =
          format === "ini"
            ? this.parseIni(content)
            : this.flattenJsonContent(content);
        languages.push({
          code: path.basename(file, ext),
          filePath,
          format,
          flattened: data,
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
      folderSuggestions: [],
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
    options?: { format?: TranslationFormat; previousGroupFiles?: string[] },
  ): Promise<void> {
    const format =
      options?.format ??
      (path.extname(filePath).toLowerCase() === ".ini"
        ? "ini"
        : path.extname(filePath).toLowerCase() === ".php"
          ? "php"
          : "json");

    if (format === "ini") {
      await fs.writeFile(filePath, this.stringifyIni(flat), "utf-8");
      return;
    }
    if (format === "php") {
      await this.writePhpLocale(filePath, flat, options?.previousGroupFiles ?? []);
      return;
    }
    const nested = this.unflatten(flat);
    const indent = this.getIndent();
    const json = JSON.stringify(nested, null, indent);
    await fs.writeFile(filePath, json + "\n", "utf-8");
  }

  /**
   * Write a CodeIgniter 4 locale directory: keys are grouped by their first
   * dot-segment (the "group", which becomes the PHP filename), the remaining
   * dot-path is nested back into a PHP associative array, and each group is
   * written to `<localeDir>/<Group>.php`. Any previously-existing group files
   * (passed via `previousGroupFiles`) that no longer contain any keys are
   * deleted so the directory stays in sync with the in-memory state.
   */
  private async writePhpLocale(
    localeDir: string,
    flat: Record<string, string>,
    previousGroupFiles: string[],
  ): Promise<void> {
    await fs.mkdir(localeDir, { recursive: true });

    // Bucket keys by group (top-level segment).
    const groups = new Map<string, Record<string, string>>();
    for (const [k, v] of Object.entries(flat)) {
      const dot = k.indexOf(".");
      if (dot <= 0) {
        // Skip keys without a group prefix — they can't be addressed in CI4
        // (`lang('Group.key')` always requires a group). Surface a warning.
        process.stderr.write(
          `i18n Data Manager: skipping CI4 key without group prefix: "${k}"\n`,
        );
        continue;
      }
      const group = k.slice(0, dot);
      if (!I18nService.CI4_GROUP_NAME.test(group)) {
        process.stderr.write(
          `i18n Data Manager: skipping CI4 key with invalid group "${group}": "${k}"\n`,
        );
        continue;
      }
      const rest = k.slice(dot + 1);
      const bucket = groups.get(group) ?? {};
      bucket[rest] = v;
      groups.set(group, bucket);
    }

    const writtenGroupFiles = new Set<string>();
    for (const [group, bucket] of groups) {
      const nested = this.unflatten(bucket);
      const content = this.stringifyPhpLangFile(nested);
      const fileName = `${group}.php`;
      await fs.writeFile(path.join(localeDir, fileName), content, "utf-8");
      writtenGroupFiles.add(fileName);
    }

    // Remove any previously-existing group files that no longer carry keys.
    for (const prev of previousGroupFiles) {
      if (writtenGroupFiles.has(prev)) continue;
      try {
        await fs.unlink(path.join(localeDir, prev));
      } catch {
        // ignore missing files
      }
    }
  }

  async addKey(key: string, values: Record<string, string>): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("Key cannot be empty.");
    const state = await this.loadState();
    if (state.languages.length === 0)
      throw new Error("No language files found. Create one first.");
    // CodeIgniter 4 keys must include a group prefix (e.g. `Messages.welcome`)
    // because the group maps to a PHP filename.
    if (state.languages.some((l) => l.format === "php")) {
      const dot = trimmed.indexOf(".");
      if (dot <= 0) {
        throw new Error(
          'CodeIgniter 4 keys must be in the form "Group.key" (e.g. "Messages.welcome").',
        );
      }
      const group = trimmed.slice(0, dot);
      if (!I18nService.CI4_GROUP_NAME.test(group)) {
        throw new Error(
          `"${group}" is not a valid CI4 group name. Use letters, digits and underscores; start with a letter or underscore.`,
        );
      }
    }
    for (const lang of state.languages) {
      const next = { ...lang.flattened };
      next[trimmed] = values[lang.code] ?? "";
      await this.writeLanguage(lang.filePath, next, {
        format: lang.format,
        previousGroupFiles: lang.groupFiles,
      });
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
    await this.writeLanguage(lang.filePath, next, {
      format: lang.format,
      previousGroupFiles: lang.groupFiles,
    });
  }

  async deleteKey(key: string): Promise<void> {
    const state = await this.loadState();
    for (const lang of state.languages) {
      if (key in lang.flattened) {
        const next = { ...lang.flattened };
        delete next[key];
        await this.writeLanguage(lang.filePath, next, {
          format: lang.format,
          previousGroupFiles: lang.groupFiles,
        });
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
        await this.writeLanguage(lang.filePath, next, {
          format: lang.format,
          previousGroupFiles: lang.groupFiles,
        });
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
    const format = this.pickNewLanguageFormat(state, copyFrom);

    const source =
      (copyFrom && state.languages.find((l) => l.code === copyFrom)) ||
      state.languages.find((l) => l.code === state.defaultLanguage) ||
      state.languages[0];

    if (format === "php") {
      // CodeIgniter 4: each locale is a SUBDIRECTORY with one PHP file per
      // group. Refuse to overwrite an existing locale directory.
      const localeDir = path.join(folder, trimmed);
      try {
        const stat = await fs.stat(localeDir);
        if (stat.isDirectory()) {
          throw new Error(`Language "${trimmed}" already exists.`);
        }
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
      }
      const data: Record<string, string> = {};
      if (source) {
        for (const k of Object.keys(source.flattened)) data[k] = "";
      }
      await this.writeLanguage(localeDir, data, { format: "php", previousGroupFiles: [] });
      return;
    }

    const filePath = path.join(folder, `${trimmed}.${format}`);
    try {
      await fs.access(filePath);
      throw new Error(`Language "${trimmed}" already exists.`);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }

    const data: Record<string, string> = {};
    if (source) {
      for (const k of Object.keys(source.flattened)) data[k] = "";
    }
    await this.writeLanguage(filePath, data, { format });
  }

  async deleteLanguage(code: string): Promise<void> {
    const state = await this.loadState();
    const lang = state.languages.find((l) => l.code === code);
    if (!lang) throw new Error(`Language "${code}" not found.`);
    if (lang.format === "php") {
      // Locale directory — remove recursively.
      await fs.rm(lang.filePath, { recursive: true, force: true });
      return;
    }
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
        await this.writeLanguage(lang.filePath, next, {
          format: lang.format,
          previousGroupFiles: lang.groupFiles,
        });
        writes++;
      }
    }
    return writes;
  }

  /**
   * Rename every key whose path starts with `oldPrefix` so that the prefix
   * becomes `newPrefix`. Used by the "auto namespace refactor" command.
   * Returns the (oldKey → newKey) map of every change applied so callers can
   * also update source-code references.
   */
  async renameNamespace(
    oldPrefix: string,
    newPrefix: string,
  ): Promise<Record<string, string>> {
    const oldP = oldPrefix.replace(/\.+$/, "");
    const newP = newPrefix.replace(/\.+$/, "");
    if (!oldP) throw new Error("Old namespace cannot be empty.");
    if (!newP) throw new Error("New namespace cannot be empty.");
    if (oldP === newP) return {};
    const state = await this.loadState();
    const mapping: Record<string, string> = {};
    for (const k of state.keys) {
      if (k === oldP || k.startsWith(oldP + ".")) {
        const tail = k === oldP ? "" : k.slice(oldP.length + 1);
        mapping[k] = tail ? `${newP}.${tail}` : newP;
      }
    }
    if (Object.keys(mapping).length === 0) return mapping;

    // Apply to every language file in one pass.
    for (const lang of state.languages) {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [k, v] of Object.entries(lang.flattened)) {
        const renamed = mapping[k];
        if (renamed) {
          if (renamed in next) {
            // Collision: prefer the existing (already-mapped) value to avoid
            // accidental data loss; surface a warning via stderr.
            process.stderr.write(
              `i18n Data Manager: namespace rename collision on "${renamed}" (from "${k}")\n`,
            );
          } else {
            next[renamed] = v;
          }
          changed = true;
        } else {
          next[k] = v;
        }
      }
      if (changed) await this.writeLanguage(lang.filePath, next, {
        format: lang.format,
        previousGroupFiles: lang.groupFiles,
      });
    }
    return mapping;
  }

  /** Apply a batch of key renames (oldKey → newKey) in a single pass. */
  async renameMany(mapping: Record<string, string>): Promise<void> {
    const entries = Object.entries(mapping).filter(([a, b]) => a && b && a !== b);
    if (entries.length === 0) return;
    const state = await this.loadState();
    for (const lang of state.languages) {
      const next: Record<string, string> = { ...lang.flattened };
      let changed = false;
      for (const [oldKey, newKey] of entries) {
        if (oldKey in next) {
          next[newKey] = next[oldKey];
          delete next[oldKey];
          changed = true;
        }
      }
      if (changed) await this.writeLanguage(lang.filePath, next, {
        format: lang.format,
        previousGroupFiles: lang.groupFiles,
      });
    }
  }

  /**
   * Ask the language model to review existing translations of a key against
   * the source language and flag issues (mistranslation, missing placeholders,
   * tone mismatch, etc.). Returns one entry per non-source language.
   */
  async reviewKeyTranslations(
    key: string,
    sourceLang: string,
    token?: vscode.CancellationToken,
  ): Promise<Array<{ language: string; verdict: "ok" | "issue" | "missing"; comment: string }>> {
    const state = await this.loadState();
    const source = state.languages.find((l) => l.code === sourceLang);
    if (!source) throw new Error(`Source language "${sourceLang}" not found.`);
    const sourceValue = source.flattened[key] ?? "";
    if (!sourceValue.trim()) {
      throw new Error(
        `Source value for "${key}" in "${sourceLang}" is empty.`,
      );
    }

    const targets = state.languages.filter((l) => l.code !== sourceLang);
    if (targets.length === 0) return [];

    const payload: Record<string, string> = {};
    for (const t of targets) payload[t.code] = t.flattened[key] ?? "";

    const prompt =
      `You are reviewing software localization quality.\n` +
      `Source key: "${key}"\n` +
      `Source language: "${sourceLang}"\n` +
      `Source value:\n"""\n${sourceValue}\n"""\n\n` +
      `Existing translations (JSON, language → value):\n${JSON.stringify(payload, null, 2)}\n\n` +
      `For EACH target language, judge whether the translation:\n` +
      `- Preserves meaning of the source.\n` +
      `- Preserves all placeholders ({name}, {{count}}, %s, %d, ICU, HTML, etc.) EXACTLY.\n` +
      `- Uses appropriate tone/register for UI copy.\n` +
      `- Is non-empty and not just a copy of the source.\n\n` +
      `Reply with ONLY a JSON object of the form:\n` +
      `{ "<lang>": { "verdict": "ok" | "issue" | "missing", "comment": "<short reason>" }, ... }\n` +
      `- "ok"      = translation is acceptable.\n` +
      `- "issue"   = translation has a problem (explain briefly in comment).\n` +
      `- "missing" = translation is empty.\n` +
      `Keep each comment under 140 characters. No markdown, no fences.`;

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

    const parsed = this.parseBatchJson(raw) ?? {};
    return targets.map((t) => {
      const entry = parsed[t.code] as
        | { verdict?: string; comment?: string }
        | undefined;
      const verdictRaw = (entry?.verdict || "").toString().toLowerCase();
      const verdict: "ok" | "issue" | "missing" =
        verdictRaw === "ok" || verdictRaw === "issue" || verdictRaw === "missing"
          ? (verdictRaw as "ok" | "issue" | "missing")
          : (payload[t.code] || "").trim() === ""
            ? "missing"
            : "issue";
      const comment = (entry?.comment ?? "").toString().slice(0, 200) ||
        (verdict === "missing" ? "Translation is empty." : "No comment.");
      return { language: t.code, verdict, comment };
    });
  }

  private static isSupportedExtension(ext: string): boolean {
    return (I18nService.SUPPORTED_EXTENSIONS as readonly string[]).includes(
      ext.toLowerCase(),
    );
  }

  private flattenJsonContent(content: string): Record<string, string> {
    const trimmed = content.trim();
    const data = trimmed.length === 0 ? {} : JSON.parse(trimmed);
    return this.flatten(data);
  }

  /**
   * Parse OBS-style locale INI files:
   *   Common.Scoreboard="Scoreboard"
   *   Common.SaveAndClose="Save && Close"
   *
   * Section headers and comment/blank lines are ignored. Dotted keys remain
   * flat so they line up with the sidebar's dot-notation model.
   */
  parseIni(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(";") || line.startsWith("#")) continue;
      if (/^\[[^\]]+\]$/.test(line)) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;

      const key = line.slice(0, eq).trim();
      if (!key) continue;
      const rawValue = line.slice(eq + 1).trim();
      result[key] = this.parseIniValue(rawValue);
    }
    return result;
  }

  private parseIniValue(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      const inner = value.slice(1, -1);
      return inner.replace(/\\(n|r|t|"|\\)/g, (_m, ch: string) => {
        switch (ch) {
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          case '"':
            return '"';
          case "\\":
            return "\\";
          default:
            return ch;
        }
      });
    }
    return value;
  }

  stringifyIni(flat: Record<string, string>): string {
    return (
      Object.keys(flat)
        .sort()
        .map((key) => `${key}="${this.escapeIniValue(flat[key] ?? "")}"`)
        .join("\n") + "\n"
    );
  }

  private escapeIniValue(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      .replace(/"/g, '\\"');
  }

  private pickNewLanguageFormat(
    state: I18nState,
    copyFrom?: string,
  ): TranslationFormat {
    const source =
      (copyFrom && state.languages.find((l) => l.code === copyFrom)) ||
      state.languages.find((l) => l.code === state.defaultLanguage) ||
      state.languages[0];
    return source?.format ?? "json";
  }

  // ─── CodeIgniter 4 PHP language files ───────────────────────

  /**
   * Parse a CodeIgniter 4 language file:
   *
   *     <?php
   *     return [
   *         'welcome'   => 'Welcome back, {name}!',
   *         'itemCount' => 'There are {0, number} items in your cart.',
   *     ];
   *
   * Supports `[...]` and `array(...)` syntax, single- and double-quoted
   * strings (with PHP escape rules), nested arrays, trailing commas, and `//`,
   * `#`, `/* ... *​/` comments. Returns the associative array as a plain JS
   * object so `flatten()` can take it from there.
   */
  parsePhpLangFile(content: string): Record<string, unknown> {
    const parser = new PhpLangParser(content);
    return parser.parseFile();
  }

  /**
   * Render a JS object back to a CodeIgniter 4 language file. Uses short-array
   * syntax (`[...]`), single-quoted strings (so embedded placeholders like
   * `$name` aren't interpolated by PHP), and 4-space indentation.
   */
  stringifyPhpLangFile(value: unknown): string {
    return `<?php\n\nreturn ${this.renderPhpValue(value, 0)};\n`;
  }

  private renderPhpValue(v: unknown, depth: number): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string") return this.phpQuote(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const indent = "    ".repeat(depth + 1);
      const close = "    ".repeat(depth);
      const lines = v.map((item) => `${indent}${this.renderPhpValue(item, depth + 1)},`);
      return `[\n${lines.join("\n")}\n${close}]`;
    }
    if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) return "[]";
      const indent = "    ".repeat(depth + 1);
      const close = "    ".repeat(depth);
      const keyWidth = Math.min(
        40,
        entries.reduce((m, [k]) => Math.max(m, this.phpQuote(k).length), 0),
      );
      const lines = entries.map(([k, val]) => {
        const quoted = this.phpQuote(k);
        const pad = quoted.length < keyWidth ? " ".repeat(keyWidth - quoted.length) : "";
        return `${indent}${quoted}${pad} => ${this.renderPhpValue(val, depth + 1)},`;
      });
      return `[\n${lines.join("\n")}\n${close}]`;
    }
    return "null";
  }

  /** Wrap a string in single quotes with PHP-style escaping (`\\` and `\'`). */
  private phpQuote(s: string): string {
    return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
}

/**
 * Minimal recursive-descent parser for CodeIgniter 4 PHP language files.
 * Only the subset of PHP that legitimately appears in those files is
 * supported (strings, numbers, booleans, null, arrays). Anything else throws.
 */
class PhpLangParser {
  private i = 0;

  constructor(private readonly src: string) {}

  parseFile(): Record<string, unknown> {
    this.skipWhitespaceAndComments();
    // Skip a leading `<?php` (or `<?=`) tag if present.
    if (this.src.startsWith("<?php", this.i)) this.i += 5;
    else if (this.src.startsWith("<?", this.i)) this.i += 2;

    // Scan forward for the first top-level `return` keyword.
    while (this.i < this.src.length) {
      this.skipWhitespaceAndComments();
      if (this.match("return") && this.isWordBoundary(this.i + 6)) {
        this.i += 6;
        this.skipWhitespaceAndComments();
        const value = this.parseValue();
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(
            "CodeIgniter 4 language file must `return [ ... ]` an associative array.",
          );
        }
        return value as Record<string, unknown>;
      }
      this.i++;
    }
    throw new Error("Could not find a `return [ ... ];` statement in language file.");
  }

  private match(word: string): boolean {
    return this.src.startsWith(word, this.i);
  }

  private isWordBoundary(pos: number): boolean {
    if (pos >= this.src.length) return true;
    return !/[A-Za-z0-9_]/.test(this.src[pos]);
  }

  private skipWhitespaceAndComments(): void {
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i++;
        continue;
      }
      if (c === "/" && this.src[this.i + 1] === "/") {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.i++;
        continue;
      }
      if (c === "#" && this.src[this.i + 1] !== "[") {
        // `#[...]` is a PHP attribute (unlikely in lang files); plain `#` is a comment.
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.i++;
        continue;
      }
      if (c === "/" && this.src[this.i + 1] === "*") {
        this.i += 2;
        while (
          this.i < this.src.length &&
          !(this.src[this.i] === "*" && this.src[this.i + 1] === "/")
        ) {
          this.i++;
        }
        this.i += 2;
        continue;
      }
      return;
    }
  }

  private parseValue(): unknown {
    this.skipWhitespaceAndComments();
    const c = this.src[this.i];
    if (c === undefined) throw new Error("Unexpected end of file");
    if (c === "'" || c === '"') return this.parseString();
    if (c === "[") return this.parseArray("]");
    if (this.match("array") && this.isWordBoundary(this.i + 5)) {
      this.i += 5;
      this.skipWhitespaceAndComments();
      if (this.src[this.i] !== "(") {
        throw new Error(`Expected "(" after array at offset ${this.i}`);
      }
      this.i++;
      return this.parseArrayBody(")");
    }
    if (this.match("true") && this.isWordBoundary(this.i + 4)) {
      this.i += 4;
      return true;
    }
    if (this.match("false") && this.isWordBoundary(this.i + 5)) {
      this.i += 5;
      return false;
    }
    if (this.match("null") && this.isWordBoundary(this.i + 4)) {
      this.i += 4;
      return null;
    }
    const numMatch = /^-?\d+(?:\.\d+)?/.exec(this.src.slice(this.i));
    if (numMatch) {
      this.i += numMatch[0].length;
      return parseFloat(numMatch[0]);
    }
    throw new Error(
      `Unexpected token at offset ${this.i}: "${this.src.slice(this.i, this.i + 20)}"`,
    );
  }

  private parseString(): string {
    const quote = this.src[this.i];
    this.i++;
    let out = "";
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === quote) {
        this.i++;
        return out;
      }
      if (c === "\\") {
        const next = this.src[this.i + 1];
        if (quote === "'") {
          // Single-quoted: only `\\` and `\'` are escapes; everything else is literal.
          if (next === "\\" || next === "'") {
            out += next;
            this.i += 2;
          } else {
            out += "\\";
            this.i++;
          }
        } else {
          // Double-quoted: handle common escapes; ignore variable interpolation.
          switch (next) {
            case "n":
              out += "\n";
              break;
            case "t":
              out += "\t";
              break;
            case "r":
              out += "\r";
              break;
            case "\\":
              out += "\\";
              break;
            case '"':
              out += '"';
              break;
            case "$":
              out += "$";
              break;
            case "0":
              out += "\0";
              break;
            default:
              out += next ?? "";
              break;
          }
          this.i += 2;
        }
        continue;
      }
      out += c;
      this.i++;
    }
    throw new Error("Unterminated string literal");
  }

  private parseArray(close: string): Record<string, unknown> | unknown[] {
    this.i++; // consume opening `[`
    return this.parseArrayBody(close);
  }

  private parseArrayBody(close: string): Record<string, unknown> | unknown[] {
    const assoc: Record<string, unknown> = {};
    const list: unknown[] = [];
    let isAssoc = false;
    while (true) {
      this.skipWhitespaceAndComments();
      if (this.src[this.i] === close) {
        this.i++;
        break;
      }
      const first = this.parseValue();
      this.skipWhitespaceAndComments();
      if (this.src[this.i] === "=" && this.src[this.i + 1] === ">") {
        this.i += 2;
        this.skipWhitespaceAndComments();
        const value = this.parseValue();
        if (typeof first !== "string" && typeof first !== "number") {
          throw new Error("Array key must be a string or number");
        }
        assoc[String(first)] = value;
        isAssoc = true;
      } else {
        list.push(first);
      }
      this.skipWhitespaceAndComments();
      if (this.src[this.i] === ",") {
        this.i++;
        continue;
      }
      if (this.src[this.i] === close) {
        this.i++;
        break;
      }
      throw new Error(
        `Expected "," or "${close}" at offset ${this.i}; saw "${this.src.slice(this.i, this.i + 10)}"`,
      );
    }
    if (isAssoc) return assoc;
    return list;
  }
}
