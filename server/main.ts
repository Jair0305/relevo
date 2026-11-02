/**
 * Punto de entrada: `node server/main.ts` (Node >= 22.18, sin paso de build).
 *
 * Variables:
 *   RELEVO_HOST            interfaz de escucha (por defecto 127.0.0.1)
 *   RELEVO_PORT            puerto (por defecto 4317)
 *   RELEVO_DATA_DIR        dónde guardar corridas (por defecto ./data)
 *   RELEVO_ALLOW_REMOTE=1  obligatorio para escuchar fuera de loopback
 *   RELEVO_ALLOWED_HOSTS   hosts extra aceptados, separados por coma
 *   RELEVO_READONLY=1      solo repeticiones; no lanza corridas
 *   RELEVO_MAX_RUNS_PER_HOUR  límite global (por defecto 30)
 */
import { fileURLToPath } from 'node:url';

import { createApp } from './http.ts';
import { RunExecutor } from './runs/executor.ts';
import { RunStore } from './runs/store.ts';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const env = process.env;
const host = env['RELEVO_HOST']?.trim() || '127.0.0.1';
const port = Number.parseInt(env['RELEVO_PORT'] ?? '4317', 10);
const readOnly = env['RELEVO_READONLY'] === '1';
const maxRunsPerHour = Number.parseInt(env['RELEVO_MAX_RUNS_PER_HOUR'] ?? '30', 10);

if (!LOOPBACK.has(host) && env['RELEVO_ALLOW_REMOTE'] !== '1') {
  process.stderr.write(
    `Relevo se niega a escuchar en ${host} sin RELEVO_ALLOW_REMOTE=1. ` +
      'Por defecto solo escucha en 127.0.0.1.\n',
  );
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write('RELEVO_PORT no es un puerto válido.\n');
  process.exit(1);
}

const allowedHosts = new Set(
  [
    `127.0.0.1:${String(port)}`,
    `localhost:${String(port)}`,
    `[::1]:${String(port)}`,
    ...(env['RELEVO_ALLOWED_HOSTS'] ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== ''),
  ].map((value) => value.toLowerCase()),
);

const store = new RunStore(env['RELEVO_DATA_DIR'] ?? `${APP_ROOT}data`, APP_ROOT);
const recovered = store.recoverInterrupted();
const executor = new RunExecutor(store, { keepWorkspaces: env['RELEVO_KEEP_WORKSPACES'] === '1' });
const server = createApp({
  store,
  executor,
  allowedHosts,
  readOnly,
  maxRunsPerHour: Number.isInteger(maxRunsPerHour) && maxRunsPerHour > 0 ? maxRunsPerHour : 30,
});

server.listen(port, host, () => {
  const shown = host.includes(':') ? `[${host}]` : host;
  process.stdout.write(
    `Relevo listo en http://${shown === '127.0.0.1' ? 'localhost' : shown}:${String(port)}` +
      `${readOnly ? ' (modo repetición)' : ''}\n`,
  );
  if (recovered > 0) process.stdout.write(`${String(recovered)} corrida(s) interrumpida(s) marcadas como fallidas.\n`);
});

function shutdown() {
  server.close();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
