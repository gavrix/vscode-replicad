# Replicad Preview

Live Replicad preview beside the native VS Code editor.

## Current state

This is the first scaffold:

- keeps the native text editor
- opens a webview preview beside it
- tracks the active document
- debounces updates
- shows document/error state in the preview

Next step is wiring actual Replicad evaluation + rendering inside the webview.

## Run in VS Code

1. Open this folder in VS Code.
2. Run `pnpm install`.
3. Press `F5` and choose `Run Extension`.
4. In the Extension Development Host window, open a Replicad-ish file and run `Replicad: Open Preview to the Side`.
