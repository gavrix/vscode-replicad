import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildPreviewPayload, type PreviewPayload } from './builder';

const VIEW_TYPE = 'replicadPreview.preview';
const PANEL_TITLE = 'Replicad Preview';
const OUTPUT_CHANNEL = 'Replicad Preview';

type PreviewMessage =
  | {
      type: 'loading';
      requestId: number;
      uri: string;
      fileName: string;
      languageId: string;
      version: number;
    }
  | {
      type: 'document';
      requestId: number;
      uri: string;
      fileName: string;
      languageId: string;
      version: number;
      code: string;
      payload: PreviewPayload;
    }
  | {
      type: 'clear';
      reason: string;
    };

type WebviewInboundMessage =
  | { type: 'ready'; state?: unknown }
  | { type: 'log'; level?: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string; stack?: string };

class Logger {
  private readonly channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL, { log: true });
  private readonly logFilePath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.logFilePath = path.join(context.extensionPath, 'logs', 'replicad-preview.log');
  }

  async init(): Promise<void> {
    await fsp.mkdir(path.dirname(this.logFilePath), { recursive: true });
    await fsp.appendFile(this.logFilePath, `\n=== session ${new Date().toISOString()} ===\n`);
    this.info(`log file: ${this.logFilePath}`);
  }

  debug(message: string): void {
    this.channel.debug(message);
    void this.append('DEBUG', message);
  }

  info(message: string): void {
    this.channel.info(message);
    void this.append('INFO', message);
  }

  warn(message: string): void {
    this.channel.warn(message);
    void this.append('WARN', message);
  }

  error(message: string): void {
    this.channel.error(message);
    void this.append('ERROR', message);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private async append(level: string, message: string): Promise<void> {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    await fsp.appendFile(this.logFilePath, line);
  }
}

class PreviewController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private activeDocumentUri: string | undefined;
  private requestId = 0;
  private pendingTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  private currentBuild: Promise<void> | undefined;
  private queuedDocument: vscode.TextDocument | undefined;
  private queuedImmediate = false;
  private webviewReady = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!this.panel || !this.activeDocumentUri) {
          return;
        }

        if (event.document.uri.toString() !== this.activeDocumentUri) {
          return;
        }

        if (this.refreshOnSaveOnly()) {
          this.logger.debug(`document changed (ignored until save): ${event.document.fileName} v${event.document.version}`);
          return;
        }

        this.logger.debug(`document changed: ${event.document.fileName} v${event.document.version}`);
        this.scheduleUpdate(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!this.panel || !this.activeDocumentUri) {
          return;
        }

        if (document.uri.toString() !== this.activeDocumentUri) {
          return;
        }

        this.logger.debug(`document saved: ${document.fileName} v${document.version}`);
        this.scheduleUpdate(document, true);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || !this.shouldAutoOpen()) {
          return;
        }

        this.logger.debug(`active editor changed: ${editor.document.fileName}`);
        void this.openForEditor(editor, vscode.ViewColumn.Beside, true);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (!this.panel || document.uri.toString() !== this.activeDocumentUri) {
          return;
        }

        this.logger.info(`document closed: ${document.fileName}`);
        this.activeDocumentUri = undefined;
        void this.panel.webview.postMessage({
          type: 'clear',
          reason: 'Document closed',
        } satisfies PreviewMessage);
      })
    );
  }

  dispose(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }

    this.panel?.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  async openFromActiveEditor(column?: vscode.ViewColumn): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.logger.warn('open preview requested without active editor');
      void vscode.window.showInformationMessage('Open a Replicad source file first.');
      return;
    }

    await this.openForEditor(editor, column);
  }

  async openForEditor(
    editor: vscode.TextEditor,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
    silent = false
  ): Promise<void> {
    if (!this.isReplicadCandidate(editor.document)) {
      this.logger.warn(`not previewable: ${editor.document.fileName}`);
      if (!silent) {
        void vscode.window.showWarningMessage('Open a .js/.ts file to preview.');
      }
      return;
    }

    this.logger.info(`opening preview for ${editor.document.fileName}`);
    const panel = this.ensurePanel(column);
    this.activeDocumentUri = editor.document.uri.toString();
    panel.title = `${PANEL_TITLE}: ${path.basename(editor.document.fileName)}`;
    this.scheduleUpdate(editor.document, true);
    panel.reveal(column, true);
  }

  private ensurePanel(column: vscode.ViewColumn): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }

    this.logger.info('creating webview panel');
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.context.extensionUri],
    });

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.webviewReady = false;
    this.panel.onDidDispose(() => {
      this.logger.info('webview panel disposed');
      this.panel = undefined;
      this.activeDocumentUri = undefined;
      this.webviewReady = false;
      this.currentBuild = undefined;
      this.queuedDocument = undefined;
      this.queuedImmediate = false;
    });

    this.panel.webview.onDidReceiveMessage((message: WebviewInboundMessage) => {
      if (!message) {
        return;
      }

      if (message.type === 'ready') {
        this.logger.info('webview ready');
        this.webviewReady = true;
        if (this.queuedDocument) {
          this.flushQueuedBuild();
        }
        return;
      }

      if (message.type === 'log') {
        const text = `[webview] ${message.message}`;
        switch (message.level) {
          case 'debug':
            this.logger.debug(text);
            break;
          case 'warn':
            this.logger.warn(text);
            break;
          case 'error':
            this.logger.error(text);
            break;
          default:
            this.logger.info(text);
            break;
        }
        return;
      }

      if (message.type === 'error') {
        this.logger.error(`[webview-error] ${message.message}${message.stack ? `\n${message.stack}` : ''}`);
      }
    });

    return this.panel;
  }

  private scheduleUpdate(document: vscode.TextDocument, immediate = false): void {
    if (!this.panel) {
      return;
    }

    this.queuedDocument = document;
    this.queuedImmediate = this.queuedImmediate || immediate;

    if (!this.webviewReady) {
      this.logger.debug(`queued build until webview ready for ${document.fileName}`);
      return;
    }

    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }

    if (immediate) {
      this.flushQueuedBuild();
      return;
    }

    this.pendingTimer = setTimeout(() => {
      this.flushQueuedBuild();
    }, this.getDebounceMs());
  }

  private flushQueuedBuild(): void {
    if (!this.panel || !this.queuedDocument) {
      return;
    }

    if (this.currentBuild) {
      this.logger.debug(`build in flight, keeping latest queued document ${this.queuedDocument.fileName}`);
      return;
    }

    const document = this.queuedDocument;
    this.queuedDocument = undefined;
    this.queuedImmediate = false;

    this.currentBuild = this.runBuild(document)
      .catch((error) => {
        this.logger.error(`unexpected build failure: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      })
      .finally(() => {
        this.currentBuild = undefined;
        if (this.queuedDocument) {
          this.flushQueuedBuild();
        }
      });
  }

  private async runBuild(document: vscode.TextDocument): Promise<void> {
    if (!this.panel) {
      return;
    }

    this.requestId += 1;
    const currentRequestId = this.requestId;
    this.logger.debug(`building request ${currentRequestId} for ${document.fileName}`);
    void this.panel.webview.postMessage({
      type: 'loading',
      requestId: currentRequestId,
      uri: document.uri.toString(),
      fileName: path.basename(document.fileName),
      languageId: document.languageId,
      version: document.version,
    } satisfies PreviewMessage);

    const payload = await buildPreviewPayload(document.getText(), document.fileName);
    this.logger.debug(`built request ${currentRequestId} with payload ${payload.kind}`);
    if (payload.telemetry) {
      this.logger.info(
        `timing request ${currentRequestId}: bundle=${payload.telemetry.bundleMs}ms execute=${payload.telemetry.executeMs}ms render=${payload.telemetry.renderMs}ms total=${payload.telemetry.totalMs}ms`
      );
    }
    if (payload.kind === 'error') {
      this.logger.error(`builder error for request ${currentRequestId}: ${payload.message}${payload.stack ? `\n${payload.stack}` : ''}`);
    }

    if (!this.panel || currentRequestId !== this.requestId) {
      this.logger.debug(`dropping stale request ${currentRequestId}`);
      return;
    }

    void this.panel.webview.postMessage({
      type: 'document',
      requestId: currentRequestId,
      uri: document.uri.toString(),
      fileName: path.basename(document.fileName),
      languageId: document.languageId,
      version: document.version,
      code: document.getText(),
      payload,
    } satisfies PreviewMessage);
  }

  private isReplicadCandidate(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return false;
    }

    const configured = vscode.workspace
      .getConfiguration('replicadPreview')
      .get<string[]>('fileExtensions', ['.js', '.jsx', '.ts', '.tsx']);

    return configured.includes(path.extname(document.fileName).toLowerCase());
  }

  private shouldAutoOpen(): boolean {
    return vscode.workspace.getConfiguration('replicadPreview').get<boolean>('autoOpen', false);
  }

  private getDebounceMs(): number {
    return vscode.workspace.getConfiguration('replicadPreview').get<number>('debounceMs', 250);
  }

  private refreshOnSaveOnly(): boolean {
    return vscode.workspace.getConfiguration('replicadPreview').get<boolean>('refreshOnSaveOnly', true);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const runtimeRoot = fs.existsSync(path.join(this.context.extensionPath, 'runtime', 'node_modules', 'three'))
      ? ['runtime', 'node_modules', 'three']
      : ['node_modules', 'three'];
    const threeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, ...runtimeRoot, 'build', 'three.module.js')
    );
    const orbitControlsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, ...runtimeRoot, 'examples', 'jsm', 'controls', 'OrbitControls.js')
    );

    const importMap = JSON.stringify({
      imports: {
        three: threeUri.toString(),
        'three/examples/jsm/controls/OrbitControls.js': orbitControlsUri.toString(),
      },
    });

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>${PANEL_TITLE}</title>
</head>
<body>
  <div id="app" class="app">
    <header class="header">
      <div>
        <div class="eyebrow">Replicad Preview</div>
        <div class="title-row">
          <h1 id="title">No file attached</h1>
          <div id="activity" class="activity hidden" aria-label="Building preview">
            <div class="spinner"></div>
          </div>
        </div>
      </div>
      <div class="status" id="status">Idle</div>
    </header>
    <main class="content content-single">
      <section class="viewer-panel panel-fill viewer-panel-full">
        <div id="viewer" class="viewer"></div>
        <div id="gizmoHost" class="gizmo-host hidden"></div>
        <div id="svgHost" class="svg-host hidden"></div>
        <div id="emptyState" class="empty-state">Open a model file. Then try returning a shape from <code>main</code>.</div>
        <div id="overlayError" class="overlay-error hidden"></div>
      </section>
    </main>
  </div>
  <script type="importmap" nonce="${nonce}">${importMap}</script>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger(context);
  await logger.init();

  const controller = new PreviewController(context, logger);

  context.subscriptions.push(
    controller,
    logger,
    vscode.commands.registerCommand('replicadPreview.openPreview', async () => {
      await controller.openFromActiveEditor(vscode.window.activeTextEditor?.viewColumn);
    }),
    vscode.commands.registerCommand('replicadPreview.openPreviewToSide', async () => {
      await controller.openFromActiveEditor(vscode.ViewColumn.Beside);
    }),
    vscode.commands.registerCommand('replicadPreview.toggleAutoPreview', async () => {
      const config = vscode.workspace.getConfiguration('replicadPreview');
      const current = config.get<boolean>('autoOpen', false);
      await config.update('autoOpen', !current, vscode.ConfigurationTarget.Global);
      logger.info(`auto preview ${!current ? 'enabled' : 'disabled'}`);
      void vscode.window.showInformationMessage(`Replicad auto preview ${!current ? 'enabled' : 'disabled'}.`);
    })
  );

  logger.info('extension activated');
}

export function deactivate(): void {}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
