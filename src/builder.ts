import * as fs from 'node:fs';
import * as path from 'node:path';
import Module from 'node:module';
import type * as EsbuildType from 'esbuild';

let opencascadeLoader: any;
let esbuildMod: typeof EsbuildType | undefined;
let replicadMod: any;

export type MeshEntry = {
  kind: 'mesh';
  name: string;
  color?: string;
  opacity?: number;
  vertices: number[];
  triangles: number[];
  normals?: number[];
};

export type SvgEntry = {
  kind: 'svg';
  name: string;
  color?: string;
  opacity?: number;
  viewBox: unknown;
  paths: string[];
};

export type BuildTelemetry = {
  bundleMs: number;
  executeMs: number;
  renderMs: number;
  totalMs: number;
};

export type PreviewPayload =
  | { kind: 'empty'; message: string; telemetry?: BuildTelemetry }
  | { kind: 'mesh'; entries: MeshEntry[]; telemetry?: BuildTelemetry }
  | { kind: 'svg'; entries: SvgEntry[]; telemetry?: BuildTelemetry }
  | { kind: 'error'; message: string; stack?: string; telemetry?: BuildTelemetry };

let runtimeReady: Promise<void> | undefined;
const bundleContexts = new Map<string, EsbuildType.BuildContext>();

export async function buildPreviewPayload(code: string, fileName: string): Promise<PreviewPayload> {
  const startedAt = performance.now();
  let bundleMs = 0;
  let executeMs = 0;
  let renderMs = 0;

  try {
    await ensureRuntime();

    const executeResult = await executeModel(code, fileName);
    bundleMs = executeResult.bundleMs;
    executeMs = executeResult.executeMs;

    const renderStartedAt = performance.now();
    const payload = renderResult(executeResult.result);
    renderMs = performance.now() - renderStartedAt;

    return {
      ...payload,
      telemetry: {
        bundleMs: roundMs(bundleMs),
        executeMs: roundMs(executeMs),
        renderMs: roundMs(renderMs),
        totalMs: roundMs(performance.now() - startedAt),
      },
    };
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      telemetry: {
        bundleMs: roundMs(bundleMs),
        executeMs: roundMs(executeMs),
        renderMs: roundMs(renderMs),
        totalMs: roundMs(performance.now() - startedAt),
      },
    };
  }
}

async function ensureRuntime(): Promise<void> {
  if (!runtimeReady) {
    runtimeReady = (async () => {
      const replicad = getReplicad();
      const loaderPath = resolveRuntimeFile('replicad-opencascadejs', path.join('src', 'replicad_single.js'));
      const wasmPath = resolveRuntimeFile('replicad-opencascadejs', path.join('src', 'replicad_single.wasm'));
      const opencascade = loadOpenCascadeLoader(loaderPath);
      const OC = await opencascade({ locateFile: () => wasmPath });
      replicad.setOC(OC);
    })();
  }

  return runtimeReady;
}

function getEsbuild(): typeof EsbuildType {
  if (!esbuildMod) {
    esbuildMod = require(resolveRuntimePackage('esbuild')) as typeof EsbuildType;
  }
  return esbuildMod;
}

function getReplicad(): any {
  if (!replicadMod) {
    replicadMod = require(resolveRuntimePackage('replicad'));
  }
  return replicadMod;
}

function resolveRuntimePackage(packageName: string): string {
  const runtimePath = path.join(__dirname, '..', 'runtime', 'node_modules', packageName);
  if (fs.existsSync(runtimePath)) {
    return runtimePath;
  }
  return packageName;
}

function resolveRuntimeFile(packageName: string, relativePath: string): string {
  const runtimePath = path.join(__dirname, '..', 'runtime', 'node_modules', packageName, relativePath);
  if (fs.existsSync(runtimePath)) {
    return runtimePath;
  }
  return require.resolve(`${packageName}/${relativePath.replace(/\\/g, '/')}`);
}

function loadOpenCascadeLoader(filename: string) {
  if (opencascadeLoader) {
    return opencascadeLoader;
  }

  const dirname = path.dirname(filename);
  const source = fs.readFileSync(filename, 'utf8').replace(/export default Module;\s*$/, 'module.exports = Module;');

  const SyntheticModule = module.constructor as any;
  const compiledModule = new SyntheticModule(filename, module.parent ?? undefined) as any;
  compiledModule.filename = filename;
  compiledModule.paths = SyntheticModule._nodeModulePaths(dirname);
  compiledModule._compile(source, filename);

  opencascadeLoader = compiledModule.exports.default || compiledModule.exports;
  return opencascadeLoader;
}

async function executeModel(
  code: string,
  fileName: string
): Promise<{ result: unknown; bundleMs: number; executeMs: number }> {
  const esbuild = getEsbuild();
  const replicad = getReplicad();

  const bundleStartedAt = performance.now();
  const bundled = await rebuildBundle(esbuild, code, fileName);
  const bundleMs = performance.now() - bundleStartedAt;

  const transpiled = bundled.outputFiles?.[0]?.text;
  if (!transpiled) {
    throw new Error('Bundling failed: no output generated.');
  }

  const module = { exports: {} as any };
  const dirname = path.dirname(fileName);

  const localRequire = (specifier: string) => {
    if (specifier === 'replicad') {
      return replicad;
    }
    return require(require.resolve(specifier, { paths: [dirname] }));
  };

  const evaluator = new Function(
    'exports',
    'module',
    'require',
    '__filename',
    '__dirname',
    `${transpiled}\nreturn {\n  defaultExport: typeof module.exports === 'function' ? module.exports : module.exports.default,\n  mainExport: typeof main !== 'undefined' ? main : module.exports.main,\n  defaultParams: typeof defaultParams !== 'undefined' ? defaultParams : module.exports.defaultParams,\n};`
  );

  const evaluated = evaluator(module.exports, module, localRequire, fileName, dirname) as {
    defaultExport?: (params?: unknown) => unknown;
    mainExport?: (replicadLib: any, params?: unknown) => unknown;
    defaultParams?: unknown;
  };

  const executeStartedAt = performance.now();

  if (typeof evaluated.defaultExport === 'function') {
    return {
      result: await evaluated.defaultExport(evaluated.defaultParams ?? {}),
      bundleMs,
      executeMs: performance.now() - executeStartedAt,
    };
  }

  if (typeof evaluated.mainExport === 'function') {
    return {
      result: await evaluated.mainExport(replicad, evaluated.defaultParams ?? {}),
      bundleMs,
      executeMs: performance.now() - executeStartedAt,
    };
  }

  throw new Error('Model must export default or define main(replicad, params).');
}

async function rebuildBundle(esbuild: typeof EsbuildType, code: string, fileName: string): Promise<EsbuildType.BuildResult> {
  const key = fileName;
  let context = bundleContexts.get(key);

  if (!context) {
    context = await esbuild.context({
      stdin: {
        contents: code,
        sourcefile: fileName,
        loader: inferLoader(fileName),
        resolveDir: path.dirname(fileName),
      },
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      sourcemap: false,
      external: ['replicad'],
      jsx: 'automatic',
      logLevel: 'silent',
      plugins: [inMemoryEntryPlugin(esbuild, fileName, code)],
    });
    bundleContexts.set(key, context);
  } else {
    context = await refreshContext(esbuild, code, fileName, context);
  }

  return context.rebuild();
}

async function refreshContext(
  esbuild: typeof EsbuildType,
  code: string,
  fileName: string,
  current: EsbuildType.BuildContext
): Promise<EsbuildType.BuildContext> {
  await current.dispose();
  const next = await esbuild.context({
    stdin: {
      contents: code,
      sourcefile: fileName,
      loader: inferLoader(fileName),
      resolveDir: path.dirname(fileName),
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    external: ['replicad'],
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [inMemoryEntryPlugin(esbuild, fileName, code)],
  });
  bundleContexts.set(fileName, next);
  return next;
}

function inMemoryEntryPlugin(esbuild: typeof EsbuildType, fileName: string, code: string): EsbuildType.Plugin {
  return {
    name: 'in-memory-entry',
    setup(build) {
      build.onLoad({ filter: /.*/ }, (args) => {
        if (path.resolve(args.path) !== path.resolve(fileName)) {
          return undefined;
        }

        return {
          contents: code,
          loader: inferLoader(fileName),
          resolveDir: path.dirname(fileName),
        } as EsbuildType.OnLoadResult;
      });
    },
  };
}

function inferLoader(fileName: string): EsbuildType.Loader {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.jsx':
      return 'jsx';
    case '.js':
    case '.mjs':
    case '.cjs':
    default:
      return 'js';
  }
}

function renderResult(result: unknown): PreviewPayload {
  const entries = normalizeEntries(result);
  if (!entries.length) {
    return { kind: 'empty', message: 'Model returned nothing.' };
  }

  if (entries.every((entry) => isSvgLike(entry.shape))) {
    return {
      kind: 'svg',
      entries: entries.map((entry) => ({
        kind: 'svg',
        name: entry.name,
        color: entry.color,
        opacity: entry.opacity,
        viewBox: entry.shape.toSVGViewBox(),
        paths: entry.shape.toSVGPaths(),
      })),
    };
  }

  if (entries.every((entry) => isMeshLike(entry.shape))) {
    return {
      kind: 'mesh',
      entries: entries.map((entry) => {
        const mesh = entry.shape.mesh({ tolerance: 0.1, angularTolerance: 30 });
        const normals = Array.isArray(mesh.normals)
          ? mesh.normals
          : ArrayBuffer.isView(mesh.normals)
            ? Array.from(mesh.normals)
            : undefined;

        return {
          kind: 'mesh',
          name: entry.name,
          color: entry.color,
          opacity: entry.opacity,
          vertices: Array.isArray(mesh.vertices) ? mesh.vertices : Array.from(mesh.vertices),
          triangles: Array.isArray(mesh.triangles) ? mesh.triangles : Array.from(mesh.triangles),
          normals,
        } satisfies MeshEntry;
      }),
    };
  }

  throw new Error('Mixed or unsupported output. Return Replicad shapes or drawings.');
}

function normalizeEntries(result: unknown): Array<{ name: string; color?: string; opacity?: number; shape: any }> {
  const items = Array.isArray(result) ? result : [result];

  return items
    .filter(Boolean)
    .map((entry: any, index) => {
      if (entry && typeof entry === 'object' && 'shape' in entry) {
        return {
          name: entry.name || `Shape ${index + 1}`,
          color: entry.color,
          opacity: entry.opacity,
          shape: adaptShape(entry.shape),
        };
      }

      return {
        name: `Shape ${index + 1}`,
        shape: adaptShape(entry),
      };
    });
}

function adaptShape(shape: any): any {
  if (!shape) return shape;
  if (isSvgLike(shape) || isMeshLike(shape)) return shape;
  if (typeof shape.face === 'function') {
    try {
      return shape.face();
    } catch {
      return shape;
    }
  }
  return shape;
}

function isSvgLike(shape: any): shape is { toSVGPaths: () => string[]; toSVGViewBox: () => unknown } {
  return !!shape && typeof shape.toSVGPaths === 'function' && typeof shape.toSVGViewBox === 'function';
}

function isMeshLike(shape: any): shape is { mesh: (config?: unknown) => any } {
  return !!shape && typeof shape.mesh === 'function';
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
