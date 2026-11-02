/**
 * Genera una captura: ejecuta una corrida REAL (igual que el botón) y guarda su
 * JSON en captures/ para que la interfaz pueda repetirla sin ejecutar nada.
 * Uso: npm run capture [-- nombre]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunExecutor } from '../server/runs/executor.ts';
import { RunStore } from '../server/runs/store.ts';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const name = process.argv[2] ?? 'corrida-referencia';
if (!/^[a-z0-9-]{3,64}$/u.test(name)) throw new Error('Nombre de captura no válido.');

const tempData = join(appRoot, 'data', 'capture-tmp');
rmSync(tempData, { recursive: true, force: true });
const store = new RunStore(tempData, appRoot);
const started = new RunExecutor(store).start();
if (started === undefined) throw new Error('No se pudo iniciar la corrida.');
const run = await started.done;
if (run.status !== 'done') throw new Error(`La corrida falló: ${run.error ?? '?'}`);

const saved = store.get(run.id);
if (saved === undefined) throw new Error('No se encontró la corrida guardada.');
mkdirSync(join(appRoot, 'captures'), { recursive: true });
const target = join(appRoot, 'captures', `${name}.json`);
writeFileSync(target, `${JSON.stringify({ ...saved, source: 'capture' }, null, 2)}\n`, 'utf8');
rmSync(tempData, { recursive: true, force: true });

const passed = saved.checks.filter((check) => check.passed).length;
process.stdout.write(`Captura ${name}: corrida ${saved.id}, ${String(saved.steps.length)} pasos, ${String(passed)}/${String(saved.checks.length)} comprobaciones.\n`);
