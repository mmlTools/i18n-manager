# Changelog

All notable changes to the **i18n Manager** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mmlTools/i18n-manager/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mmlTools/i18n-manager/releases/tag/v1.0.0
