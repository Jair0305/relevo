/**
 * Pruebas contra Concord real (procesos concord-mcp por stdio y el CLI), en
 * carpetas desechables bajo data/. Comprueban el comportamiento del que
 * depende Relevo, no la implementación de Relevo.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONCORD_MCP_ENTRY, concordEnv, concordNodeArgs, sandboxPaths, type SandboxPaths } from '../server/concord/sandbox.ts';
import { ConcordSession, type ToolCallRecord } from '../server/concord/session.ts';
import { asArray, asNumber, asString, field } from '../server/scenario/json.ts';
import { concordCheck } from '../server/scenario/probes.ts';
import { prepareWorkspace, SHARED_FILE } from '../server/scenario/workspace.ts';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const testRoot = join(appRoot, 'data', `test-concord-${String(process.pid)}`);
const sessions: ConcordSession[] = [];

async function workspace(name: string): Promise<{ dir: string; paths: SandboxPaths }> {
  const dir = join(testRoot, name);
  const paths = sandboxPaths(dir);
  await prepareWorkspace(paths.workspace, paths.home);
  return { dir, paths };
}

async function open(agent: string, paths: SandboxPaths, dir: string): Promise<ConcordSession> {
  const session = await ConcordSession.open(agent, paths, dir, () => undefined);
  sessions.push(session);
  return session;
}

function claim(session: ConcordSession, taskId: string): Promise<ToolCallRecord> {
  return session.call('start_work', {
    task_id: taskId,
    title: `Tarea ${taskId}`,
    kind: 'actor-demo',
    expected_files: [SHARED_FILE],
  });
}

async function version(session: ConcordSession, taskId: string): Promise<number> {
  const call = await session.call('inspect_work', { task_id: taskId });
  const value = asNumber(field(call.structured, 'task', 'version'));
  assert.ok(value !== undefined, call.text);
  return value;
}

before(() => mkdirSync(testRoot, { recursive: true }));
after(async () => {
  await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3 });
});

describe('Concord 0.19.0 en el sandbox de Relevo', () => {
  it('detecta el choque de reserva, no lo bloquea, y concord check lo hace cumplir', async () => {
    const { dir, paths } = await workspace('choque');
    const a = await open('a', paths, dir);
    const b = await open('b', paths, dir);
    assert.ok((await claim(a, 'T-A')).ok);
    const second = await claim(b, 'T-B');
    assert.ok(second.ok, 'el reclamo con choque se acepta: Concord avisa, no bloquea');
    const overlaps = asArray(field(second.structured, 'overlaps'));
    assert.equal(asString(field(overlaps[0], 'task_id')), 'T-A');
    assert.match(second.text, /1 overlap/u);

    assert.equal((await concordCheck(paths, dir, 'T-B', SHARED_FILE)).exitCode, 1);
    assert.equal((await concordCheck(paths, dir, 'T-B', 'src/otro.js')).exitCode, 0, 'solo frena el mismo archivo');

    const finish = await a.call('finish_work', {
      task_id: 'T-A',
      expected_version: await version(a, 'T-A'),
      outcome: 'review_ready',
      what_changed: 'listo',
    });
    assert.ok(finish.ok, finish.text);
    assert.equal((await concordCheck(paths, dir, 'T-B', SHARED_FILE)).exitCode, 0, 'review_ready libera el archivo');
  });

  it('entrega mensajes por cola con acuse, y la bandeja es privada', async () => {
    const { dir, paths } = await workspace('mensajes');
    const a = await open('a', paths, dir);
    const b = await open('b', paths, dir);
    await claim(a, 'T-A');
    await claim(b, 'T-B');
    const prompt = await b.call('update_work', {
      operation: 'prompt',
      to_agent_id: 'a',
      task_id: 'T-B',
      content: '¿me pasas el archivo?',
      idempotency_key: 'k-1',
    });
    assert.ok(prompt.ok, prompt.text);
    assert.equal(asString(field(prompt.structured, 'delivery')), 'queued_pull');
    const messageId = asString(field(prompt.structured, 'message_id')) ?? '';

    const retry = await b.call('update_work', {
      operation: 'prompt',
      to_agent_id: 'a',
      task_id: 'T-B',
      content: '¿me pasas el archivo?',
      idempotency_key: 'k-1',
    });
    assert.equal(asString(field(retry.structured, 'message_id')), messageId, 'misma clave, mismo mensaje');

    const peek = await b.call('inspect_work', { agent_id: 'a' });
    assert.equal(field(peek.structured, 'private'), true, 'b no puede leer la bandeja de a');

    const inbox = await a.call('inspect_work', { agent_id: 'a' });
    const message = asArray(field(inbox.structured, 'inbox')).find((m) => asString(field(m, 'messageId')) === messageId);
    assert.equal(asString(field(message, 'status')), 'read');

    const forged = await b.call('update_work', {
      operation: 'reply',
      reply_to_message_id: messageId,
      content: 'me respondo solo',
      idempotency_key: 'k-2',
    });
    assert.equal(forged.ok, false, 'solo el destinatario puede responder');

    const reply = await a.call('update_work', {
      operation: 'reply',
      reply_to_message_id: messageId,
      content: 'sí',
      idempotency_key: 'k-3',
    });
    assert.ok(reply.ok, reply.text);
  });

  it('una sesión nueva recupera lo anotado antes de que la anterior se cayera', async () => {
    const { dir, paths } = await workspace('caida');
    const first = await open('r', paths, dir);
    await claim(first, 'T-R');
    const note = await first.call('update_work', { task_id: 'T-R', kind: 'intent', content: 'cambiar > por >=' });
    assert.ok(note.ok, note.text);
    first.crash();

    const second = await open('r', paths, dir);
    const resume = await second.call('inspect_work', { task_id: 'T-R' });
    const updates = asArray(field(resume.structured, 'updates'));
    assert.ok(updates.some((u) => asString(field(u, 'content')) === 'cambiar > por >='));
    const again = await claim(second, 'T-R');
    assert.equal(asString(field(again.structured, 'resumed_by')), 'claim', 'retoma su propia tarea');
  });

  it('el relevo exige versión vigente, rechaza el duplicado y deja historial', async () => {
    const { dir, paths } = await workspace('relevo');
    const owner = await open('dueno', paths, dir);
    const next = await open('siguiente', paths, dir);
    await claim(owner, 'T-H');
    const current = await version(owner, 'T-H');

    const stale = await owner.call('transfer_work', {
      task_id: 'T-H',
      action: 'offer',
      to_agent_id: 'siguiente',
      expected_version: current + 5,
      what_changed: 'x',
    });
    assert.equal(stale.ok, false);
    assert.match(stale.text, /version conflict/u);

    const offer = await owner.call('transfer_work', {
      task_id: 'T-H',
      action: 'offer',
      to_agent_id: 'siguiente',
      expected_version: current,
      what_changed: 'arreglo con pruebas',
      tests_run: ['node --test'],
    });
    assert.ok(offer.ok, offer.text);
    const offered = asNumber(field(offer.structured, 'version')) ?? 0;

    const intruder = await owner.call('transfer_work', { task_id: 'T-H', action: 'accept', expected_version: offered });
    assert.equal(intruder.ok, false, 'el relevo no es para el emisor');

    const accepts = await Promise.all([
      next.call('transfer_work', { task_id: 'T-H', action: 'accept', expected_version: offered }),
      next.call('transfer_work', { task_id: 'T-H', action: 'accept', expected_version: offered }),
    ]);
    assert.equal(accepts.filter((call) => call.ok).length, 1);

    const decision = await owner.call('update_work', { task_id: 'T-H', kind: 'decision', content: 'ya no es mía' });
    assert.equal(decision.ok, false, 'el dueño anterior ya no puede decidir');

    const context = await next.call('inspect_work', { task_id: 'T-H' });
    assert.equal(asString(field(context.structured, 'task', 'agentId')), 'siguiente');
    assert.ok(asArray(field(context.structured, 'ownership_history')).length >= 2);
  });

  it('el sandbox impide que Concord salga de la carpeta de la corrida', () => {
    // Sin .git propio, Concord sube por los directorios buscando un repo; el
    // modelo de permisos lo corta antes de llegar al repo que contiene la app.
    const dir = join(testRoot, 'sin-git');
    const paths = sandboxPaths(dir);
    mkdirSync(paths.workspace, { recursive: true });
    const result = spawnSync(process.execPath, concordNodeArgs(CONCORD_MCP_ENTRY, dir), {
      cwd: paths.workspace,
      env: concordEnv(paths, 'x'),
      input: '',
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restricted|allow-fs-read/u);
  });

  it('la guardia de red bloquea fetch y sockets pero deja pasar URLs data:', () => {
    const guard = fileURLToPath(new URL('../server/concord/network-guard.mjs', import.meta.url));
    const script = [
      "const r = await fetch('data:text/plain,hola').then((x) => x.text());",
      "const f = await fetch('https://example.com').then(() => 'salió', () => 'bloqueado');",
      "let s = 'bloqueado'; try { (await import('node:net')).connect(443, 'example.com'); s = 'salió'; } catch {}",
      'console.log(r, f, s);',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--import', new URL(`file:///${guard.replace(/\\/gu, '/')}`).href, '--input-type=module', '-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(out.trim(), 'hola bloqueado bloqueado');
  });
});
