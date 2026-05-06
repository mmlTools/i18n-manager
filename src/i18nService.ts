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
}

export class I18nService {
  resolveFolderPath(): string | undefined {
    const config = vscode.workspace.getConfiguration('i18nManager');
    const setting = (config.get<string>('translationsPath') || '').trim();
    if (!setting) return undefined;
    if (path.isAbsolute(setting)) return setting;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;
    return path.join(ws.uri.fsPath, setting);
  }

  getDefaultLanguage(): string {
    return vscode.workspace.getConfiguration('i18nManager').get<string>('defaultLanguage') || 'en';
  }

  getIndent(): number {
    const n = vscode.workspace.getConfiguration('i18nManager').get<number>('indent');
    return typeof n === 'number' && n >= 0 ? n : 2;
  }

  async loadState(): Promise<I18nState> {
    const defaultLanguage = this.getDefaultLanguage();
    const folderPath = this.resolveFolderPath();

    if (!folderPath) {
      return {
        configured: false,
        folderPath: '',
        folderDisplay: '',
        languages: [],
        keys: [],
        defaultLanguage
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
        defaultLanguage
      };
    }

    const files = await fs.readdir(folderPath);
    const languages: LanguageData[] = [];

    for (const file of files) {
      if (!file.toLowerCase().endsWith('.json')) continue;
      const filePath = path.join(folderPath, file);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        const trimmed = content.trim();
        const data = trimmed.length === 0 ? {} : JSON.parse(trimmed);
        languages.push({
          code: file.replace(/\.json$/i, ''),
          filePath,
          flattened: this.flatten(data)
        });
      } catch (e) {
        console.error(`i18n Manager: failed to read ${file}`, e);
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
      defaultLanguage
    };
  }

  private toDisplayPath(absolute: string): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws && absolute.startsWith(ws.uri.fsPath)) {
      const rel = path.relative(ws.uri.fsPath, absolute);
      return rel === '' ? '.' : rel;
    }
    return absolute;
  }

  flatten(obj: unknown, prefix = ''): Record<string, string> {
    const result: Record<string, string> = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return result;
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(result, this.flatten(value, newKey));
      } else if (value === null || value === undefined) {
        result[newKey] = '';
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
      const parts = key.split('.');
      let cur: Record<string, unknown> = result;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        const existing = cur[p];
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
          cur[p] = {};
        }
        cur = cur[p] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = flat[key];
    }
    return result;
  }

  async writeLanguage(filePath: string, flat: Record<string, string>): Promise<void> {
    const nested = this.unflatten(flat);
    const indent = this.getIndent();
    const json = JSON.stringify(nested, null, indent);
    await fs.writeFile(filePath, json + '\n', 'utf-8');
  }

  async addKey(key: string, values: Record<string, string>): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('Key cannot be empty.');
    const state = await this.loadState();
    if (state.languages.length === 0) throw new Error('No language files found. Create one first.');
    for (const lang of state.languages) {
      const next = { ...lang.flattened };
      next[trimmed] = values[lang.code] ?? '';
      await this.writeLanguage(lang.filePath, next);
    }
  }

  async updateValue(key: string, languageCode: string, value: string): Promise<void> {
    const state = await this.loadState();
    const lang = state.languages.find(l => l.code === languageCode);
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
    if (!trimmed) throw new Error('New key cannot be empty.');
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
    if (!trimmed) throw new Error('Language code cannot be empty.');
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      throw new Error('Language code may only contain letters, numbers, hyphens and underscores.');
    }
    const state = await this.loadState();
    const folder = state.folderPath;
    if (!folder) throw new Error('No translations folder is configured.');
    const filePath = path.join(folder, `${trimmed}.json`);

    try {
      await fs.access(filePath);
      throw new Error(`Language "${trimmed}" already exists.`);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw e;
    }

    const data: Record<string, string> = {};
    const source =
      (copyFrom && state.languages.find(l => l.code === copyFrom)) ||
      state.languages.find(l => l.code === state.defaultLanguage) ||
      state.languages[0];
    if (source) {
      for (const k of Object.keys(source.flattened)) data[k] = '';
    }
    await this.writeLanguage(filePath, data);
  }

  async deleteLanguage(code: string): Promise<void> {
    const state = await this.loadState();
    const lang = state.languages.find(l => l.code === code);
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
          next[k] = '';
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
