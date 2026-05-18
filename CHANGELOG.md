# Changelog

All notable changes to the **i18n Data Manager** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **CodeIgniter 4 PHP language file support.** Point the extension at your `app/Language/` folder and it now understands the CI4 layout where each locale is a subdirectory (`en/`, `es/`, …) and each PHP file inside is a "group" (`Messages.php`, `Buttons.php`, …) returning an associative array. Keys are displayed in the sidebar as `Group.subkey` (e.g. `Messages.welcome`, `Buttons.warnLabel`) — the exact same shape used in `lang('Messages.welcome', ['name' => 'Alex'])`. The format is auto-detected from the folder layout and is also surfaced as a one-click suggestion in the empty state when an `app/Language/` folder is found in the workspace.
  - Reading: a small recursive-descent PHP parser handles short-array (`[...]`) and long-array (`array(...)`) syntax, single- and double-quoted strings (with PHP escape rules), nested arrays, trailing commas, and `//` / `#` / `/* */` comments.
  - Writing: keys are bucketed by their first dot-segment (the group → PHP filename) and the remaining dot-path is nested back into a PHP associative array. Group files that no longer contain any keys are deleted; new groups create new `.php` files automatically. Output uses short-array syntax with single-quoted strings (so PHP variables in placeholders like `$name` are not interpolated).
  - Code integration: `lang('Group.key', ...)` is recognised everywhere a `t(...)` call is — hover preview, CodeLens, missing-key / empty-translation diagnostics, hardcoded-string detection, *Find Unused Keys*, *Rename Globally*, *Auto Namespace Refactor*, *AI Review Translations*, *Show Key References*, *Translate Selection* and *Create Translation Key from Selection (AI)*. PHP files are now scanned by all of these features.
- Support OBS-style `.ini` translation files alongside JSON. Locale folders can now be detected from `en-US.ini`, files are parsed as flat dotted keys like `Common.Scoreboard="Scoreboard"`, and edits are written back as quoted `key="value"` lines.

## [1.5.1] - 2026-05-11

### Added

- **Auto-detected translations folder suggestions in the empty state.** When no folder is configured yet, the sidebar now scans the workspace for folders containing locale-named JSON files (`en.json`, `en_US.json`, `en-US.json`, `zh-Hans.json`, …) and shows them as one-click cards. The "Choose Translations Folder" button stays as a fallback. Heavy directories (`node_modules`, `dist`, `build`, `.git`, …) are skipped.

## [1.5.0] - 2026-05-11

### Added — Code integration features

- **Hover preview of every language** above any translation key in your code (`t("…")`, `$t("…")`, `i18next.t("…")`, `<Trans i18nKey="…">`, `'…' | translate`). Shows a markdown table of all languages with command links to reveal the key, translate it, or rename it globally.
- **CodeLens** above key call sites with the default-language value inline, so you can read your UI copy without leaving the file.
- **Diagnostics:**
  - `i18n.missingKey` — a key referenced in code is not defined in any language file.
  - `i18n.emptyTranslation` — a key exists but is empty in some language files.
  - `i18n.hardcodedString` — heuristic detection of human-readable string/JSX literals that aren't wrapped in a translation call.
- **Quick-fixes:**
  - "Extract to translation key (AI)" on hardcoded-string diagnostics — runs the existing AI key-suggestion flow on the selected literal.
  - "Create this key" on missing-key diagnostics — adds the key with one prompt for the source value.
- **`i18n: Find Unused Translation Keys`** — scans the workspace for key references and lists keys that no source file uses; multi-select and delete in one go.
- **`i18n: Rename Translation Key Globally…`** — renames the key in every language file AND every code reference in the workspace, then saves the affected source files.
- **`i18n: Auto Namespace Refactor…`** — pick a prefix like `comp.foo` and rename it to `components.foo`; every key under it (and every code reference) is updated atomically.
- **`i18n: AI Review Translations…`** — asks the language model to judge each translation of a key against the source for meaning, placeholder integrity, tone, and emptiness; results land in the new "i18n Review" output channel.
- **`i18n: Show Key References`** — lists every code reference of the key under the cursor (also available from the editor context menu).

### Configuration

- New settings under `LocaleSynci18n.codeIntegration.*` to toggle each new feature individually:
  - `hover`, `codeLens`, `diagnostics`, `hardcodedDetection` (all default `true`).

## [1.4.1] - 2026-05-07

### Changed

- **`LocaleSynci18n.keyInsertTemplate` now defaults to `${key}`** — i.e. the selection is replaced with the bare key path, with no `t('…')` wrapper. The previous default assumed an `i18next`-style helper that's a project-local convention; users that want a wrapper can set the template explicitly (e.g. `"t('${key}')"`, `"$t('${key}')"`, or any other shape).
- README and CHANGELOG references to `t('your.key')` updated to reflect the new default.

## [1.4.0] - 2026-05-07

### Added

- **"Create Translation Key from Selection (AI)" command.** Select any free-form text in your editor, right-click and pick **i18n: Create Translation Key from Selection (AI)** (also in the Command Palette). The extension:
  - Asks for the source language (defaults to your default language).
  - Sends the selection to the language model with the project's existing top-level groups as context, and gets back a nicely-nested key path such as `fixes.redundantText` for *"Fixed the card files uploads by removing the redundant webkit building"*.
  - Sanitises the reply (lowerCamelCase segments, dot notation, ASCII-only, length-capped) and ensures uniqueness against existing keys.
  - Lets you accept or tweak the suggested key in an input box (with the last segment pre-selected for fast renaming).
  - Creates the key with the selection as the source value, then translates it into every other language using the existing `translateKeyToAll` flow.
  - Replaces the selection with the configured `LocaleSynci18n.keyInsertTemplate` (the key path).
- New `I18nService.suggestKeyPath(text, { existingKeys, sourceLang })` and `sanitizeKeyPath(raw)` helpers powering the suggestion flow.

## [1.3.0] - 2026-05-07

### Added

- **Translate Selection now recognises key paths.** When the selected text is itself an existing key (e.g. `comp.externalsTable.accessCategoryTypeNameHeader`), the QuickPick clearly shows that the translation already exists and lists every language's value as a preview.
- **Sibling-key suggestions.** Whatever the selection, the QuickPick also shows existing keys whose **last segment** matches (e.g. picking `accessCategoryTypeNameHeader` surfaces every key ending in `.accessCategoryTypeNameHeader`), so you can reuse a related entry instead of creating a new one.
- **Smart pre-fill in the Create flow.** When the selection looks like a key path, the *new key* input is pre-filled with it; otherwise the *source value* input is pre-filled with the selection. The flow now asks for key → source language → source value (each pre-filled where it makes sense).
- **Sectioned QuickPick** with separators for *Existing translations*, *Same value as the selection*, and *Other keys ending in ".…"* so the choices are easy to scan.

### Changed

- **Auto-translate of new language files is now batched.** Instead of one round-trip per key, values are sent to the language model in chunks (~50 keys / ~6000 chars per request) as a JSON object and parsed back, which is dramatically faster on large files.
  - If a batch reply can't be parsed, the affected entries automatically fall back to per-key translation so a single bad reply never aborts the job.
  - Progress notifications now report `batch i/n (N keys)` instead of one tick per key.

## [1.2.0] - 2026-05-07

### Added

- **Translate Selection from the editor.** Select any string in your code, right-click and pick **i18n: Translate Selection…** (also available from the Command Palette).
  - Searches every language's values for matches and offers to **reuse an existing key** when one is found (exact and case-insensitive matches, with the matching value previewed).
  - Otherwise lets you **create a new key on the fly**: pick the source language, name the key (validated against duplicates), and the selected text is stored as the source value.
  - When a language model is available, optionally translates the new key into every other language right away (reuses the existing `translateKeyToAll` flow with progress + cancellation).
  - The selection in your code is replaced according to the new `LocaleSynci18n.keyInsertTemplate` setting (uses `${key}` as a placeholder).
- **Auto-translate when creating a new language file.** The *Add Language* dialog now has an **Auto-translate values with AI** checkbox (shown when a model is available). When checked, every key is translated from the chosen source language right after the file is created, with cancellable progress and a summary toast.
- New setting `LocaleSynci18n.keyInsertTemplate` to control how the editor selection is rewritten after the *Translate Selection* command.
- New command contribution `LocaleSynci18n.translateSelection`, registered in the editor context menu.

### Internal

- `I18nService.findKeysByValue(text)` returns existing keys whose value matches the given text (exact matches first, then case-insensitive).
- `I18nService.translateLanguageFile(target, source, { overwrite }, token, progress)` translates every key of a target language file from a source language, tolerating individual failures and reporting `translated / skipped / failed` counts.

## [1.1.0] - 2026-05-06

### Added

- **AI translation via the VS Code Language Model API.** Works with GitHub Copilot or any other installed LM provider, no API key required, no provider locked in.
  - Per-language ✨ button next to each language inside an expanded translation key. Click it to pick a source language and translate that single value.
  - Global **✨ Translate all** button in the key's actions row. Pick a source language and the key is translated into every other language at once.
  - When some target languages already have a value, you're prompted to either overwrite all of them or only fill the empty ones.
  - Cancellable progress notifications during translation.
  - Placeholder, HTML, and ICU MessageFormat preservation built into the prompt.
- New setting `i18nManager.aiTranslate.enabled` (default `true`) to disable AI buttons even when a model is available.
- Sidebar now refreshes automatically when extensions are installed/uninstalled, so the AI buttons appear the moment a provider is added.

### Changed

- Bumped minimum VS Code version from `1.75.0` to `1.90.0` (required for the stable Language Model API).
- The extension is fully functional without any LM provider, the AI buttons simply don't render, and every existing feature works exactly as it did before.

## [1.0.0] - 2026-05-06

### Added

- Sidebar control panel in a dedicated activity-bar view.
- Configure translations folder via picker (saved to workspace settings).
- Auto-detect every `*.json` language file in the configured folder.
- Add a translation key to every language file at once via a single form.
- Inline editing of any value, with auto-save on blur and `Ctrl/Cmd+Enter`.
- Add new language files pre-populated with all existing keys (empty values).
- Delete language files and translation keys from a single place.
- Rename keys across all language files atomically.
- Search across both key names and value text.
- "Incomplete only" filter to surface missing translations.
- "Sync missing keys" button to fill any keys missing from any file with empty placeholders.
- Per-key completeness indicator (`n/total` badge).
- Support for both flat and nested JSON structures (auto-flatten/re-nest with dot notation).
- File-system watcher that refreshes the sidebar on external file changes.
- Configurable JSON indentation, default language, and translations path.

[Unreleased]: https://github.com/mmlTools/localesync-i18n/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/mmlTools/localesync-i18n/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/mmlTools/localesync-i18n/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/mmlTools/localesync-i18n/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/mmlTools/localesync-i18n/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mmlTools/localesync-i18n/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mmlTools/localesync-i18n/releases/tag/v1.0.0
