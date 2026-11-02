/**
 * El repositorio sintético de cada carril. Se copia del fixture, se inicializa
 * como repo git propio (sin remoto) y solo se tocan rutas de una lista fija.
 * Ningún dato de la petición HTTP llega a estas funciones.
 */
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const FIXTURE_DIR: string = fileURLToPath(new URL('./fixture/', import.meta.url));
export const SHARED_FILE = 'src/totales.js';
const EDITABLE_FILES: ReadonlySet<string> = new Set([SHARED_FILE]);

function editablePath(workspace: string, file: string): string {
  if (!EDITABLE_FILES.has(file)) {
    throw new Error(`Relevo solo edita ${[...EDITABLE_FILES].join(', ')}.`);
  }
  return join(workspace, ...file.split('/'));
}

export function readShared(workspace: string): string {
  return readFileSync(editablePath(workspace, SHARED_FILE), 'utf8');
}

export function writeShared(workspace: string, content: string): void {
  writeFileSync(editablePath(workspace, SHARED_FILE), content, 'utf8');
}

/**
 * git con configuración aislada: sin config global/sistema del usuario, sin
 * hooks, sin firma. Así un `commit.gpgsign` o un hook personal no se cuelan.
 */
async function git(workspace: string, home: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(
    'git',
    [
      '-c',
      'core.hooksPath=',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Relevo (actor de demostración)',
      '-c',
      'user.email=relevo@example.invalid',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      cwd: workspace,
      timeout: 15_000,
      windowsHide: true,
      env: {
        PATH: process.env['PATH'] ?? '',
        ...(process.env['SystemRoot'] === undefined
          ? {}
          : { SystemRoot: process.env['SystemRoot'] }),
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(home, '.gitconfig-relevo'),
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
  return stdout;
}

/** Copia el fixture y deja un commit `base` con los dos fallos. */
export async function prepareWorkspace(workspace: string, home: string): Promise<void> {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig-relevo'), '', 'utf8');
  cpSync(FIXTURE_DIR, workspace, { recursive: true });
  await git(workspace, home, ['init', '-q']);
  await git(workspace, home, ['add', '-A']);
  await git(workspace, home, ['commit', '-q', '-m', 'base: La Espiga con dos fallos']);
  await git(workspace, home, ['tag', 'base']);
}

export async function commitShared(
  workspace: string,
  home: string,
  message: string,
): Promise<void> {
  await git(workspace, home, ['add', SHARED_FILE]);
  await git(workspace, home, ['commit', '-q', '--allow-empty', '-m', message]);
}

/** Diff unificado del archivo compartido contra la versión inicial. */
export async function diffFromBase(workspace: string, home: string): Promise<string> {
  const out = await git(workspace, home, ['diff', '--no-color', 'base', '--', SHARED_FILE]);
  return out.split('\n').slice(0, 60).join('\n').trimEnd();
}
