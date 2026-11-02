/**
 * El servidor HTTP: límites de acceso y el flujo completo de una corrida real
 * de principio a fin (POST → sondeo → resultado guardado sin rutas locales).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/http.ts';
import { RunExecutor } from '../server/runs/executor.ts';
import { RunStore } from '../server/runs/store.ts';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const dataDir = join(appRoot, 'data', `test-http-${String(process.pid)}`);
const servers: { close(): void }[] = [];

async function serve(readOnly = false): Promise<{ base: string; host: string }> {
  const store = new RunStore(dataDir, appRoot);
  const app = createApp({
    store,
    executor: new RunExecutor(store),
    allowedHosts: new Set(['relevo.test']),
    readOnly,
    maxRunsPerHour: 5,
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  servers.push(app);
  const port = (app.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${String(port)}`, host: 'relevo.test' };
}

interface Reply {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** node:http en lugar de fetch: fetch no deja fijar la cabecera Host. */
function req(
  base: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; host?: string } = {},
): Promise<Reply> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: init.method ?? 'GET',
        headers: { ...init.headers, host: init.host ?? 'relevo.test' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: { get: (name) => { const v = response.headers[name.toLowerCase()]; return typeof v === 'string' ? v : null; } },
            text: () => Promise.resolve(body),
            json: () => Promise.resolve(JSON.parse(body)),
          });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

before(() => mkdirSync(dataDir, { recursive: true }));
after(() => {
  for (const server of servers) server.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('servidor de Relevo', () => {
  it('rechaza hosts ajenos, escrituras sin intención y orígenes cruzados', async () => {
    const { base } = await serve();
    assert.equal((await req(base, '/api/status', { host: 'evil.example' })).status, 421);
    assert.equal((await req(base, '/api/runs', { method: 'POST' })).status, 403);
    const cross = await req(base, '/api/runs', {
      method: 'POST',
      headers: { 'x-relevo-intent': '1', origin: 'http://evil.example' },
    });
    assert.equal(cross.status, 403);
    assert.equal((await req(base, '/api/runs', { method: 'DELETE' })).status, 403);
  });

  it('solo sirve archivos de su lista y con CSP', async () => {
    const { base } = await serve();
    const home = await req(base, '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'self'/u);
    for (const path of ['/server/main.ts', '/../package.json', '/%2e%2e/package.json', '/api/runs/..%2f..%2fpackage', '/api/captures/..%2fx']) {
      const res = await req(base, path);
      assert.equal(res.status, 404, path);
    }
  });

  it('en modo repetición no lanza ni borra corridas', async () => {
    const { base } = await serve(true);
    const res = await req(base, '/api/runs', { method: 'POST', headers: { 'x-relevo-intent': '1' } });
    assert.equal(res.status, 403);
    const sentinel = join(dataDir, 'runs', 'readonly-sentinel.txt');
    writeFileSync(sentinel, 'dato que debe conservarse');
    const deletion = await req(base, '/api/runs', { method: 'DELETE', headers: { 'x-relevo-intent': '1' } });
    assert.equal(deletion.status, 403);
    assert.ok(existsSync(sentinel), 'el modo repetición conserva los datos');
  });

  it('rechaza una URL malformada sin interrumpir el servidor', async () => {
    const { base } = await serve();
    assert.equal((await req(base, 'http://[')).status, 400);
    assert.equal((await req(base, '/api/status')).status, 200);
  });

  it('ejecuta una corrida real completa y la guarda sin rutas locales', async () => {
    const { base } = await serve();
    const start = await req(base, '/api/runs', { method: 'POST', headers: { 'x-relevo-intent': '1' } });
    assert.equal(start.status, 202);
    const { id } = (await start.json()) as { id: string };

    const busy = await req(base, '/api/runs', { method: 'POST', headers: { 'x-relevo-intent': '1' } });
    assert.equal(busy.status, 409, 'una corrida a la vez');

    let run: { status: string; checks: { id: string; passed: boolean }[]; steps: unknown[] } | undefined;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const res = await req(base, `/api/runs/${id}`);
      run = (await res.json()) as typeof run;
      if (run?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.equal(run?.status, 'done');
    const failed = run.checks.filter((check) => !check.passed).map((check) => check.id);
    assert.deepEqual(failed, [], 'todas las comprobaciones de la corrida se cumplen');
    assert.ok(run.steps.length >= 30);

    const raw = await (await req(base, `/api/runs/${id}`)).text();
    for (const secret of [appRoot, homedir(), JSON.stringify(homedir()).slice(1, -1)]) {
      assert.equal(raw.includes(secret), false, `no debe aparecer ${secret}`);
    }
    assert.equal(existsSync(join(dataDir, 'runs', id)), false, 'la carpeta de trabajo se borra al terminar');
  });

  it('reiniciar borra solo data/runs', async () => {
    const { base } = await serve();
    const keep = join(dataDir, 'no-tocar.txt');
    writeFileSync(keep, 'x');
    const res = await req(base, '/api/runs', { method: 'DELETE', headers: { 'x-relevo-intent': '1' } });
    assert.equal(res.status, 200);
    const status = (await (await req(base, '/api/status')).json()) as { runs: unknown[] };
    assert.equal(status.runs.length, 0);
    assert.ok(existsSync(keep));
  });
});
