# i18n Manager

[![Version](https://img.shields.io/visual-studio-marketplace/v/MMLTECH.i18n-manager?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=MMLTECH.i18n-manager)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/MMLTECH.i18n-manager)](https://marketplace.visualstudio.com/items?itemName=MMLTECH.i18n-manager)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/MMLTECH.i18n-manager)](https://marketplace.visualstudio.com/items?itemName=MMLTECH.i18n-manager)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A clean, sidebar-based control panel for managing your i18n translation files.
Add new keys to **every language file at once**, create new language files in a click,
and spot missing translations at a glance without ever leaving VS Code.

## Features

- **Sidebar control panel** - a dedicated activity-bar view with everything you need.
- **Configure once** - point it at the folder where your `*.json` translation files live (per-workspace setting).
- **One key, all languages** - adding a new translation key writes to every language file in sync.
- **Inline editing** - click any key to expand and edit values for every language right in the sidebar. Saves on blur or `Ctrl/Cmd+Enter`.
- **Add languages in a click** - new language files come pre-populated with all existing keys (empty, ready to translate).
- **Sync check** - find keys missing in some files and fill them in (with empty values) in one click.
- **Smart search** - filter by key name *or* by the value text in any language.
- **Incomplete-only filter** - instantly see what still needs translating.
- **Nested keys supported** - dot-notation in the UI (`common.buttons.submit`), nested JSON on disk.
- **Theme-aware** - uses VS Code's theme variables, so it matches whatever you've got.

## 📸 Preview

>
> ```markdown
> ![Sidebar overview](images/sidebar.png)
> ![Add key dialog](images/add-key.png)
> ```

## Getting started

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=MMLTECH.i18n-manager).
2. Open a workspace that contains your translation files.
3. Click the 🌐 **i18n Manager** icon in the activity bar.
4. Click **Choose Translations Folder** and pick the folder containing your `en.json`, `fr.json`, etc.
5. Done, start adding keys and languages from the sidebar.

## Expected file layout

The extension expects one JSON file per language inside the configured folder. The filename
(without `.json`) is taken as the language code:

```
locales/
├── en.json
├── fr.json
├── es.json
└── de-DE.json
```

Both flat (`{ "hello": "Hi" }`) and nested (`{ "common": { "hello": "Hi" } }`) JSON are
supported. Nested files are flattened to dot-notation in the UI and re-nested on write,
preserving your existing structure.

## Keyboard shortcuts (inside the sidebar)

| Shortcut             | Action                                            |
| -------------------- | ------------------------------------------------- |
| `Ctrl/Cmd + Enter`   | Save the focused value field, or submit a modal. |
| `Esc`                | Revert the value being edited / close a modal.   |

## Settings

| Setting                         | Description                                                            | Default |
| ------------------------------- | ---------------------------------------------------------------------- | ------- |
| `i18nManager.translationsPath`  | Folder containing your `*.json` translation files (relative or abs.).  | `""`    |
| `i18nManager.defaultLanguage`   | The "source" language. Shown first and used as template for new langs. | `"en"`  |
| `i18nManager.indent`            | Spaces of indentation when writing JSON.                               | `2`     |

These settings are written to your **workspace** settings, so each project can have its own config.

## Commands

Available from the Command Palette (`Ctrl/Cmd+Shift+P`):

- `i18n Manager: Configure Translations Folder`
- `i18n Manager: Refresh`

## Build from source

```bash
git clone https://github.com/mmlTools/i18n-manager.git
cd i18n-manager
npm install
npm run compile
```

Then open the folder in VS Code and press **F5** to launch the Extension Development Host.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev workflow.

## Package & publish

```bash
npm install -g @vscode/vsce
npm run package        # → i18n-manager-1.0.0.vsix
npm run publish        # publishes to the marketplace (requires `vsce login`)
```

## Known limitations

- Only `.json` files are supported (not `.yaml`, `.po`, `.properties`, etc.).
- Pluralization rules (CLDR plural categories) aren't handled, values are treated as plain strings.
- Comments in JSON files aren't preserved (standard `JSON.parse` / `JSON.stringify`).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## License

[MIT](LICENSE) © StreamRsc.com
