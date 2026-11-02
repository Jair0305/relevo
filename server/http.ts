/**
 * Servidor HTTP de Relevo. Superficie deliberadamente pequeña:
 *
 *   GET    /                    interfaz (archivos de una lista fija)
 *   GET    /api/status          versión, corridas guardadas, capturas
 *   POST   /api/runs            lanza la corrida del escenario fijo
 *   GET    /api/runs/:id        una corrida (también mientras corre)
 *   DELETE /api/runs            borra solo las corridas locales
 *   GET    /api/captures/:name  una corrida real capturada (repetición)
 *
 * Ninguna petición aporta rutas, comandos ni contenido para ejecutar.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONCORD_VERSION } from './concord/sandbox.ts';
import type { RunExecutor } from './runs/executor.ts';
import { parseRun, RUN_ID_PATTERN, type RunStore } from './runs/store.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
export const CAPTURES_DIR = fileURLToPath(new URL('../captures/', import.meta.url));
const CAPTURE_NAME = /^[a-z0-9-]{3,64}$/u;

const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/render.js': { file: 'render.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export interface AppOptions {
  readonly store: RunStore;
  readonly executor: RunExecutor;
  /** Hosts aceptados en la cabecera Host (contra DNS rebinding). */
  readonly allowedHosts: ReadonlySet<string>;
  /** Modo solo-repetición: no permite lanzar corridas (para exponerlo). */
  readonly readOnly: boolean;
  /** Corridas permitidas por hora (todas las IPs juntas). */
  readonly maxRunsPerHour: number;
}

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

export function listCaptures(): { name: string; id: string; startedAt: string }[] {
  if (!existsSync(CAPTURES_DIR)) return [];
  return readdirSync(CAPTURES_DIR)
    .filter((file) => file.endsWith('.json') && CAPTURE_NAME.test(file.slice(0, -5)))
    .flatMap((file) => {
      const run = parseRun(readFileSync(join(CAPTURES_DIR, file), 'utf8'));
      return run === undefined ? [] : [{ name: file.slice(0, -5), id: run.id, startedAt: run.startedAt }];
    });
}

/** Las peticiones que cambian algo deben venir de la propia página. */
function sameOriginWrite(req: IncomingMessage): boolean {
  if (req.headers['x-relevo-intent'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createApp(options: AppOptions): Server {
  const runTimes: number[] = [];

  return createServer((req, res) => {
    const host = req.headers.host ?? '';
    if (!options.allowedHosts.has(host.toLowerCase())) {
      send(res, 421, 'Host no permitido.', 'text/plain; charset=utf-8');
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://relevo.local');
    } catch {
      json(res, 400, { error: 'URL de petición no válida.' });
      return;
    }
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path in STATIC_FILES) {
      const entry = STATIC_FILES[path];
      if (entry === undefined) return;
      send(res, 200, readFileSync(join(WEB_DIR, entry.file), 'utf8'), entry.type);
      return;
    }

    if (method === 'GET' && path === '/api/status') {
      json(res, 200, {
        concordVersion: CONCORD_VERSION,
        node: process.version,
        platform: process.platform,
        readOnly: options.readOnly,
        running: options.executor.runningId,
        runs: options.store.list(),
        captures: listCaptures(),
      });
      return;
    }

    if (path === '/api/runs' && method === 'POST') {
      if (!sameOriginWrite(req)) {
        json(res, 403, { error: 'Petición rechazada: debe venir de la propia página.' });
        return;
      }
      if (options.readOnly) {
        json(res, 403, { error: 'Este servidor está en modo repetición: no lanza corridas nuevas.' });
        return;
      }
      const now = Date.now();
      while (runTimes.length > 0 && (runTimes[0] ?? now) < now - 3_600_000) runTimes.shift();
      if (runTimes.length >= options.maxRunsPerHour) {
        json(res, 429, { error: 'Límite de corridas por hora alcanzado. Prueba la repetición capturada.' });
        return;
      }
      const started = options.executor.start();
      if (started === undefined) {
        json(res, 409, { error: 'Ya hay una corrida en curso.', running: options.executor.runningId });
        return;
      }
      runTimes.push(now);
      started.done.catch(() => undefined);
      json(res, 202, { id: started.id });
      return;
    }

    if (path === '/api/runs' && method === 'DELETE') {
      if (!sameOriginWrite(req)) {
        json(res, 403, { error: 'Petición rechazada: debe venir de la propia página.' });
        return;
      }
      if (options.readOnly) {
        json(res, 403, { error: 'Este servidor está en modo repetición: no modifica corridas guardadas.' });
        return;
      }
      if (options.executor.runningId !== null) {
        json(res, 409, { error: 'Espera a que termine la corrida en curso.' });
        return;
      }
      options.store.reset();
      json(res, 200, { ok: true });
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/u.exec(path);
    if (method === 'GET' && runMatch !== null) {
      const id = runMatch[1] ?? '';
      const run = RUN_ID_PATTERN.test(id) ? options.store.get(id) : undefined;
      if (run === undefined) json(res, 404, { error: 'No existe esa corrida.' });
      else json(res, 200, run);
      return;
    }

    const captureMatch = /^\/api\/captures\/([^/]+)$/u.exec(path);
    if (method === 'GET' && captureMatch !== null) {
      const name = captureMatch[1] ?? '';
      const capture = listCaptures().find((item) => item.name === name);
      if (capture === undefined) {
        json(res, 404, { error: 'No existe esa captura.' });
        return;
      }
      const run = parseRun(readFileSync(join(CAPTURES_DIR, `${capture.name}.json`), 'utf8'));
      json(res, 200, run === undefined ? { error: 'Captura dañada.' } : { ...run, source: 'capture' });
      return;
    }

    if (path.startsWith('/api/')) json(res, 404, { error: 'Ruta desconocida.' });
    else send(res, 404, 'No encontrado.', 'text/plain; charset=utf-8');
  });
}
