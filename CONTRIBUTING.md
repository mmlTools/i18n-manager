# Contributing to i18n Data Manager

Thanks for your interest in contributing! This document covers the dev setup and the
small set of conventions used in this codebase.

## Dev setup

```bash
git clone https://github.com/mmlTools/i18n-data-manager.git
cd i18n-data-manager
npm install
```

Open the folder in VS Code and press **F5** to launch the Extension Development Host.
The TypeScript watch task starts automatically (configured in `.vscode/tasks.json`),
so any change in `src/**` rebuilds and the dev host can be reloaded with
`Ctrl/Cmd+R`.

## Project layout

```
src/
├── extension.ts        # Activation, commands, file watcher
├── i18nService.ts      # Read/write translation files, flatten/unflatten
└── sidebarProvider.ts  # WebviewViewProvider bridges UI ↔ extension

media/
├── main.css            # Sidebar styles (uses VS Code theme variables)
├── main.js             # Sidebar UI (vanilla JS, no framework)
├── icon.svg            # Activity-bar icon (monochrome, currentColor)
└── icon.png            # Marketplace icon (256×256)

scripts/
└── make_icon.py        # Regenerates media/icon.png
```

## Conventions

- **No frameworks in the webview.** `main.js` is intentionally vanilla so the bundle
  stays tiny and start-up is instant. A small `el(tag, props, children)` helper plus
  full re-renders on state changes is the whole rendering model.
- **CSS uses VS Code theme variables.** Never hard-code colors read from
  `var(--vscode-...)` so the extension matches the user's theme.
- **All file I/O lives in `i18nService.ts`.** The provider only orchestrates messages
  and shows native dialogs; the service does the actual reading and writing.
- **State flows one way.** UI sends a typed message → extension performs the action →
  extension sends fresh `state` → UI re-renders.

## Running the linter / typechecker

```bash
npm run compile   # full TypeScript build
npm run lint      # ESLint over src/
```

## Packaging a release locally

```bash
npm install -g @vscode/vsce
npm run package   # produces i18n-data-manager-X.Y.Z.vsix
```

Install the resulting `.vsix` into your normal VS Code with:

```bash
code --install-extension i18n-data-manager-X.Y.Z.vsix
```

## Pull requests

1. Fork and create a branch from `main`.
2. Keep PRs focused one feature or fix per PR.
3. Update `CHANGELOG.md` under `[Unreleased]` with a short bullet describing your change.
4. Make sure `npm run compile` passes.

## Reporting bugs

Open an issue with:

- Your OS and VS Code version.
- Your `i18nManager.*` settings.
- A description of the expected vs. actual behavior.
- A minimal sample translations folder if relevant.
