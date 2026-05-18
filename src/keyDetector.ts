import * as vscode from 'vscode';

/**
 * A reference to a translation key found in source code.
 * `range` covers the key STRING ONLY (without surrounding quotes), so
 * editor edits/highlights line up with what the user sees.
 */
export interface KeyReference {
  key: string;
  range: vscode.Range;
  /** Quote character used around the key (', " or `). */
  quote: string;
  /** The full match range INCLUDING the call expression (`t("foo")`). */
  fullRange: vscode.Range;
}

/**
 * Regexes that match common i18n call shapes. Every regex MUST capture:
 *   group 1 = quote char
 *   group 2 = key string
 * and the overall match begins at the call expression so we can compute a
 * `fullRange` for CodeLens placement.
 *
 * We intentionally keep this list small and conservative so we don't trigger
 * on unrelated code. Users can disable detection per-language via the
 * `LocaleSynci18n.codeIntegration.languages` setting.
 */
const KEY_PATTERNS: RegExp[] = [
  // t("key"), $t("key"), i18n.t("key"), i18next.t("key")
  /(?:\b(?:i18next|i18n)\s*\.\s*)?\$?t\s*\(\s*(['"`])([A-Za-z0-9_$][A-Za-z0-9_$.\-:/]*)\1/g,
  // useTranslation(...).t — handled by the above too
  // <Trans i18nKey="key">
  /\bi18nKey\s*=\s*(['"`])([A-Za-z0-9_$][A-Za-z0-9_$.\-:/]*)\1/g,
  // translate("key") (Angular/Vue helpers)
  /\btranslate\s*\(\s*(['"`])([A-Za-z0-9_$][A-Za-z0-9_$.\-:/]*)\1/g,
  // Pipe-style: 'key' | translate
  /(['"`])([A-Za-z0-9_$][A-Za-z0-9_$.\-:/]*)\1\s*\|\s*translate\b/g,
  // CodeIgniter 4: lang('Group.key') — the dot between group and key is required.
  /\blang\s*\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_$.\-:/]+)\1/g,
];

/** Default file selectors that the integration features apply to. */
export const DEFAULT_SELECTORS: vscode.DocumentSelector = [
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'javascriptreact' },
  { scheme: 'file', language: 'vue' },
  { scheme: 'file', language: 'svelte' },
  { scheme: 'file', language: 'html' },
  { scheme: 'file', language: 'php' },
];

/** True when the document is one we should scan for keys. */
export function isSupportedDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file') return false;
  const allowed = new Set([
    'typescript',
    'typescriptreact',
    'javascript',
    'javascriptreact',
    'vue',
    'svelte',
    'html',
    'php',
  ]);
  return allowed.has(doc.languageId);
}

/** Find every translation-key reference in a document. */
export function findKeyReferencesInText(
  text: string,
  doc: vscode.TextDocument,
): KeyReference[] {
  const refs: KeyReference[] = [];
  for (const pattern of KEY_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const quote = m[1];
      const key = m[2];
      const fullStart = m.index;
      const fullEnd = fullStart + m[0].length;
      // Locate the key INSIDE the match so highlight covers the string only.
      const keyOffsetInMatch = m[0].lastIndexOf(quote + key + quote);
      const keyStart = fullStart + (keyOffsetInMatch >= 0 ? keyOffsetInMatch + 1 : 0);
      const keyEnd = keyStart + key.length;
      refs.push({
        key,
        quote,
        range: new vscode.Range(doc.positionAt(keyStart), doc.positionAt(keyEnd)),
        fullRange: new vscode.Range(
          doc.positionAt(fullStart),
          doc.positionAt(fullEnd),
        ),
      });
    }
  }
  return refs;
}

/** Convenience wrapper that pulls text from the document. */
export function findKeyReferences(doc: vscode.TextDocument): KeyReference[] {
  return findKeyReferencesInText(doc.getText(), doc);
}

/**
 * Heuristic detector for hard-coded UI strings — string/JSX literals that
 * look like human-readable English and aren't already wrapped in a `t(...)`
 * call. Conservative by design: we only flag strings that:
 *   - contain a space (single-word labels are too ambiguous), AND
 *   - start with a letter, AND
 *   - aren't inside an obvious i18n call / import / require / URL / regex / log
 *
 * Returns ranges of the string CONTENT (without surrounding quotes).
 */
export interface HardcodedString {
  text: string;
  range: vscode.Range;
}

const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
const JSX_TEXT = />([^<>{}\n][^<>{}]{1,200})</g;

const NON_UI_PARENT = /(?:\bimport\b|\brequire\b|\bconsole\.[a-z]+|\bthrow new\s+\w+|\b(?:i18next|i18n)\s*\.\s*)?\$?\bt\s*\(\s*$|\bi18nKey\s*=\s*$|\btranslate\s*\(\s*$|\blang\s*\(\s*$/;
const URL_OR_PATH = /^(?:https?:|file:|mailto:|\/|\.\/|\.\.\/|[a-z]+:\/\/)/i;
const LOOKS_LIKE_PROP = /^[a-z][a-zA-Z0-9_-]*$/;
const HAS_LETTER_AND_SPACE = /[A-Za-z].*\s.*[A-Za-z]/;

export function findHardcodedStrings(doc: vscode.TextDocument): HardcodedString[] {
  const out: HardcodedString[] = [];
  const text = doc.getText();

  // 1) String literals that look like UI copy.
  STRING_LITERAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRING_LITERAL.exec(text)) !== null) {
    const content = m[2];
    if (!isUiLikeString(content)) continue;

    // Skip strings preceded by an i18n call shape, JSX attribute we know is
    // non-UI (className, key, id, href, src, etc.), or import/require.
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    if (NON_UI_PARENT.test(before)) continue;
    if (/\b(?:className|class|id|href|src|alt|style|key|name|type|rel|target|method|action|aria-[a-z]+)\s*=\s*$/.test(before)) continue;
    if (/\bimport\b[^;]*$/.test(before)) continue;
    if (/\brequire\s*\(\s*$/.test(before)) continue;

    const start = m.index + 1; // skip opening quote
    const end = start + content.length;
    out.push({
      text: content,
      range: new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
    });
  }

  // 2) JSX text nodes between `>...<`.
  JSX_TEXT.lastIndex = 0;
  while ((m = JSX_TEXT.exec(text)) !== null) {
    const content = m[1];
    const trimmed = content.trim();
    if (!isUiLikeString(trimmed)) continue;
    const offset = m.index + 1 + content.indexOf(trimmed);
    const start = offset;
    const end = start + trimmed.length;
    out.push({
      text: trimmed,
      range: new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
    });
  }

  return out;
}

function isUiLikeString(s: string): boolean {
  if (!s) return false;
  if (s.length < 4 || s.length > 200) return false;
  if (!HAS_LETTER_AND_SPACE.test(s)) return false;
  if (URL_OR_PATH.test(s)) return false;
  if (LOOKS_LIKE_PROP.test(s)) return false;
  if (/^[A-Z_][A-Z0-9_]+$/.test(s)) return false; // SCREAMING_SNAKE
  if (/^\$\{|\$\(/.test(s)) return false; // template fragments
  if (/^[\d\s+\-.,:%/]+$/.test(s)) return false; // numeric-ish
  // Looks like a key path (dotted) → likely already an i18n key.
  if (/^[a-z][a-zA-Z0-9_$]*(?:\.[a-zA-Z0-9_$]+)+$/.test(s)) return false;
  return true;
}
