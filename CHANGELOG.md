# Changelog

All notable changes to the **i18n Data Manager** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mmlTools/i18n-data-manager/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/mmlTools/i18n-data-manager/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mmlTools/i18n-data-manager/releases/tag/v1.0.0
