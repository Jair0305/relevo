/**
 * Persistencia de corridas: un JSON por corrida en `data/runs/` más la carpeta
 * de trabajo de esa corrida. Solo se borra lo que está dentro de `data/runs/`.
 *
 * Antes de guardar, las rutas locales (carpeta de la app, HOME del usuario) se
 * sustituyen por marcadores, para que una corrida se pueda compartir sin
 * revelar la estructura de carpetas de quien la ejecutó.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { CONCORD_VERSION } from '../concord/sandbox.ts';
import type { RunRecord } from '../scenario/types.ts';

export const RUN_ID_PATTERN = /^r-[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/u;
const KEEP_RUNS = 12;

export interface RunSummary {
  readonly id: string;
  readonly source: RunRecord['source'];
  readonly status: RunRecord['status'];
  readonly startedAt: string;
  readonly checksPassed: number;
  readonly checksTotal: number;
}

function pathVariants(path: string): string[] {
  const forward = path.replace(/\\/gu, '/');
  const variants = [path, forward, JSON.stringify(path).slice(1, -1), JSON.stringify(forward).slice(1, -1)];
  return [...new Set(variants)].filter((variant) => variant.length > 3);
}

/** Sustituye rutas locales y ids de workspace (base64 de una ruta). */
export function redact(json: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  let out = json;
  const pairs = replacements
    .flatMap(([path, label]) => pathVariants(path).map((variant) => [variant, label] as const))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [variant, label] of pairs) out = out.split(variant).join(label);
  return out.replace(/ws_[A-Za-z0-9_-]{16,}/gu, 'ws_<workspace-de-la-corrida>');
}

export class RunStore {
  readonly dataDir: string;
  readonly runsDir: string;
  readonly #appRoot: string;

  constructor(dataDir: string, appRoot: string) {
    this.dataDir = resolve(dataDir);
    this.runsDir = join(this.dataDir, 'runs');
    this.#appRoot = resolve(appRoot);
    mkdirSync(this.runsDir, { recursive: true });
  }

  newId(now = new Date()): string {
    const iso = now.toISOString().replace(/[-:T]/gu, '').slice(0, 14);
    return `r-${iso.slice(0, 8)}-${iso.slice(8, 14)}-${randomBytes(3).toString('hex')}`;
  }

  /** Carpeta de trabajo de una corrida (solo para ids generados aquí). */
  workDir(id: string): string {
    if (!RUN_ID_PATTERN.test(id)) throw new Error('Id de corrida no válido.');
    return join(this.runsDir, id);
  }

  create(id: string): RunRecord {
    return {
      schema: 1,
      id,
      source: 'live',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      environment: { concordVersion: CONCORD_VERSION, node: process.version, platform: process.platform },
      steps: [],
      lanes: {},
      checks: [],
      artifacts: null,
      isolation: null,
      error: null,
    };
  }

  save(record: RunRecord): void {
    const json = redact(JSON.stringify(record, null, 2), [
      [this.workDir(record.id), '<corrida>'],
      [this.#appRoot, '<relevo>'],
      [homedir(), '~'],
    ]);
    const target = join(this.runsDir, `${record.id}.json`);
    const temp = `${target}.tmp`;
    writeFileSync(temp, json, 'utf8');
    renameSync(temp, target);
  }

  get(id: string): RunRecord | undefined {
    if (!RUN_ID_PATTERN.test(id)) return undefined;
    const file = join(this.runsDir, `${id}.json`);
    if (!existsSync(file)) return undefined;
    return parseRun(readFileSync(file, 'utf8'));
  }

  list(): RunSummary[] {
    return readdirSync(this.runsDir)
      .filter((name) => name.endsWith('.json') && RUN_ID_PATTERN.test(name.slice(0, -5)))
      .map((name) => this.get(name.slice(0, -5)))
      .filter((run): run is RunRecord => run !== undefined)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((run) => ({
        id: run.id,
        source: run.source,
        status: run.status,
        startedAt: run.startedAt,
        checksPassed: run.checks.filter((check) => check.passed).length,
        checksTotal: run.checks.length,
      }));
  }

  /** Deja solo las corridas más recientes (JSON y carpeta de trabajo). */
  prune(keep = KEEP_RUNS): void {
    for (const run of this.list().slice(keep)) this.remove(run.id);
  }

  remove(id: string): void {
    if (!RUN_ID_PATTERN.test(id)) return;
    rmSync(join(this.runsDir, `${id}.json`), { force: true });
    rmSync(this.workDir(id), { recursive: true, force: true, maxRetries: 3 });
  }

  /** Reinicio: borra todo `data/runs/` y nada más. */
  reset(): void {
    rmSync(this.runsDir, { recursive: true, force: true, maxRetries: 3 });
    mkdirSync(this.runsDir, { recursive: true });
  }

  /** Corridas que quedaron «running» por un apagado brusco pasan a fallidas. */
  recoverInterrupted(): number {
    let recovered = 0;
    for (const summary of this.list()) {
      const run = this.get(summary.id);
      if (run?.status !== 'running') continue;
      run.status = 'failed';
      run.finishedAt = new Date().toISOString();
      run.error = 'El servidor se detuvo durante la corrida. Puedes volver a correrla.';
      this.save(run);
      rmSync(this.workDir(run.id), { recursive: true, force: true, maxRetries: 3 });
      recovered += 1;
    }
    return recovered;
  }
}

/** Validación mínima de un JSON guardado (corridas propias o captura). */
export function parseRun(text: string): RunRecord | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === 'object' &&
      value !== null &&
      'schema' in value &&
      value.schema === 1 &&
      'id' in value &&
      typeof value.id === 'string' &&
      'steps' in value &&
      Array.isArray(value.steps)
    ) {
      return value as RunRecord;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
