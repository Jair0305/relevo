/**
 * Las dos únicas órdenes externas que ejecuta un carril, ambas fijas:
 *  - las pruebas del fixture (`node --test-reporter=tap tests/totales.test.js`)
 *    con el modelo de permisos de Node: solo lectura del workspace;
 *  - `concord check` (el CLI real de Concord) como guardia antes de editar.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';

import {
  CONCORD_CLI_ENTRY,
  concordEnv,
  concordNodeArgs,
  type SandboxPaths,
} from '../concord/sandbox.ts';
import type { GuardResult, TestCase, TestResult } from './types.ts';

interface Exec {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function exec(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { ...options, timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ exitCode: code, stdout, stderr });
      },
    );
  });
}

/** Lee la salida TAP de node:test: solo los casos de primer nivel. */
export function parseTap(tap: string): TestCase[] {
  const lines = tap.split(/\r?\n/u);
  const cases: TestCase[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const match = /^(not ok|ok) \d+ - (.+)$/u.exec(line);
    if (match === null) continue;
    const ok = match[1] === 'ok';
    let reason: string | null = null;
    if (!ok) {
      const errorAt = lines.findIndex((text, index) => index > i && /^\s+error: /u.test(text));
      if (errorAt !== -1) {
        const collected: string[] = [];
        for (let j = errorAt + 1; j < lines.length && collected.length < 8; j += 1) {
          const text = lines[j] ?? '';
          if (/^\s{2}\w+:/u.test(text)) break;
          if (text.trim() !== '') collected.push(text.trim());
        }
        reason = collected.join('\n') || null;
      }
    }
    cases.push({ name: match[2] ?? '', ok, reason });
  }
  return cases;
}

export async function runFixtureTests(paths: SandboxPaths): Promise<TestResult> {
  const started = performance.now();
  const args = [
    '--permission',
    `--allow-fs-read=${paths.workspace}`,
    '--disable-warning=ExperimentalWarning',
    '--test-reporter=tap',
    join('tests', 'totales.test.js'),
  ];
  const result = await exec(process.execPath, args, {
    cwd: paths.workspace,
    env: { ...concordEnv(paths), NODE_ENV: 'test' },
  });
  const cases = parseTap(result.stdout);
  return {
    command: 'node --test-reporter=tap tests/totales.test.js',
    exitCode: result.exitCode,
    passed: cases.filter((testCase) => testCase.ok).length,
    failed: cases.filter((testCase) => !testCase.ok).length,
    cases,
    durationMs: Math.round(performance.now() - started),
  };
}

/** `concord check --task <propia> <archivo>`: 0 libre, 1 choque. */
export async function concordCheck(
  paths: SandboxPaths,
  runDir: string,
  ownTaskId: string,
  file: string,
): Promise<GuardResult> {
  const args = [
    ...concordNodeArgs(CONCORD_CLI_ENTRY, runDir),
    '--repo',
    paths.workspace,
    'check',
    '--task',
    ownTaskId,
    file,
  ];
  const result = await exec(process.execPath, args, {
    cwd: paths.workspace,
    env: concordEnv(paths),
  });
  return {
    command: `concord check --task ${ownTaskId} ${file}`,
    exitCode: result.exitCode,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}
