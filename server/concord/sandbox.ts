/**
 * Cómo lanza Relevo los binarios de Concord: siempre con un entorno construido
 * desde cero (lista blanca), un HOME falso dentro de la carpeta de la corrida y
 * el modelo de permisos de Node activo. Nada hereda variables de la sesión que
 * arranca Relevo (tokens, ids de sesión de Claude Code, etc.).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Raíz del paquete de Concord instalado (versión fijada en package.json). */
export const CONCORD_PACKAGE_DIR: string = dirname(
  require.resolve('@concord-ai/concord-mcp/package.json'),
);
export const CONCORD_MCP_ENTRY: string = join(CONCORD_PACKAGE_DIR, 'dist', 'index.js');
export const CONCORD_CLI_ENTRY: string = join(CONCORD_PACKAGE_DIR, 'dist', 'cli', 'index.js');
export const CONCORD_VERSION: string = readConcordVersion();

const NETWORK_GUARD: string = fileURLToPath(new URL('./network-guard.mjs', import.meta.url));
/** Carpeta `node_modules` que contiene a Concord y sus dependencias. */
const NODE_MODULES_DIR: string = resolve(CONCORD_PACKAGE_DIR, '..', '..');

function readConcordVersion(): string {
  const manifest: unknown = require('@concord-ai/concord-mcp/package.json');
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'version' in manifest &&
    typeof manifest.version === 'string'
  ) {
    return manifest.version;
  }
  throw new Error('No se pudo leer la versión de @concord-ai/concord-mcp.');
}

export interface SandboxPaths {
  /** Repositorio sintético donde trabajan los actores. */
  readonly workspace: string;
  /** HOME falso: aquí caería cualquier `~/.concord` o `~/.config`. */
  readonly home: string;
}

export function sandboxPaths(runDir: string): SandboxPaths {
  return { workspace: join(runDir, 'workspace'), home: join(runDir, 'home') };
}

/**
 * Entorno mínimo para un proceso de Concord. Telemetría y comprobación de
 * versiones desactivadas; el workspace queda fijado y es la única raíz
 * permitida; la identidad la pone el operador (Relevo), no la sesión.
 */
export function concordEnv(paths: SandboxPaths, agentId?: string): Record<string, string> {
  const home = paths.home;
  mkdirSync(join(home, 'tmp'), { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(home, 'tmp'),
    TEMP: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
    CONCORD_REPO_ROOT: paths.workspace,
    CONCORD_ALLOWED_ROOTS: paths.workspace,
    CONCORD_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    CONCORD_NO_UPDATE_CHECK: '1',
    // Por si algo ignorara lo anterior: un destino local que no escucha.
    CONCORD_TELEMETRY_URL: 'http://127.0.0.1:9/relevo-telemetry-disabled',
    // Un tipo que no es ningún arnés: evita la autorreparación de adaptadores.
    CONCORD_AGENT_KIND: 'actor-demo',
    NODE_ENV: 'production',
  };
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot !== undefined) env['SystemRoot'] = systemRoot;
  if (agentId !== undefined) env['CONCORD_AGENT_ID'] = agentId;
  return env;
}

/**
 * Argumentos de `node` para ejecutar un binario de Concord con el modelo de
 * permisos: lectura solo del paquete y la corrida, escritura solo en la
 * corrida, sin procesos hijos ni workers. `--allow-addons` es necesario para
 * better-sqlite3 (módulo nativo incluido en el paquete).
 */
export function concordNodeArgs(entry: string, runDir: string): string[] {
  return [
    '--permission',
    `--allow-fs-read=${NODE_MODULES_DIR}`,
    `--allow-fs-read=${NETWORK_GUARD}`,
    `--allow-fs-read=${runDir}`,
    `--allow-fs-write=${runDir}`,
    '--allow-addons',
    '--disable-warning=ExperimentalWarning',
    '--disable-warning=SecurityWarning',
    '--import',
    pathToFileURL(NETWORK_GUARD).href,
    entry,
  ];
}
