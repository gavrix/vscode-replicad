# Replicad Preview

Preview Replicad models beside the native VS Code editor.

This extension keeps the normal text editor and opens a rendered Replicad preview in a side webview panel, more like Markdown Preview than a custom editor. Replacing the real editor just to show CAD would be a silly own-goal.

## Features

- keeps the native VS Code editor intact
- opens preview beside the current editor
- renders real Replicad output
- supports local imports through an esbuild-based preview pipeline
- refreshes on save by default
- shows a minimal 3D scene with a corner gizmo and error overlay

## Commands

- `Replicad: Open Preview`
- `Replicad: Open Preview to the Side`
- `Replicad: Toggle Auto Preview`

## Settings

### `replicadPreview.autoOpen`
Automatically open or retarget the preview when a matching editor becomes active.

Default: `false`

### `replicadPreview.fileExtensions`
File extensions considered for Replicad preview heuristics.

Default:

```json
[".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts"]
```

### `replicadPreview.debounceMs`
Debounce delay before preview updates.

Default: `250`

### `replicadPreview.refreshOnSaveOnly`
Only rebuild the preview when the file is saved.

Default: `true`

## Build and install

### Prerequisites

- `pnpm` for development dependencies
- `npm` for packaging the runtime that goes inside the VSIX

Install dev dependencies once:

```bash
pnpm install
```

Build the installable VSIX:

```bash
npm run build
```

That produces:

```text
vscode-replicad-preview-0.0.1.vsix
```

Install it in normal VS Code:

1. Run `Extensions: Install from VSIX...`
2. Choose the generated `vscode-replicad-preview-0.0.1.vsix`
3. Reload VS Code
4. Open a Replicad source file
5. Run `Replicad: Open Preview to the Side`

## Development

Run the extension in an Extension Development Host:

1. Open this folder in VS Code
2. Press `F5`
3. Open a Replicad source file
4. Run `Replicad: Open Preview to the Side`

## Notes

- Heavy models can still be slow. Telemetry says execution dominates, not rendering.
- The packaged extension installs runtime dependencies under `runtime/` before building the VSIX.
- This project is still early, but at least it is now usefully early instead of merely theoretical.

## License

[MIT](./LICENSE)
