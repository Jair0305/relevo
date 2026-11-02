/**
 * El laboratorio: el mismo incidente en dos carriles aislados.
 *
 *  - «Sin coordinar»: dos actores leen el archivo a la vez y cada uno guarda su
 *    copia. Sin Concord.
 *  - «Con Concord»: los mismos actores y los mismos cambios, pero cada uno
 *    trabaja a través de su propio proceso `concord-mcp` (MCP real) y respeta
 *    la guardia `concord check` antes de editar.
 *
 * Nada aquí se inventa: cada paso guarda la respuesta del proceso que lo hizo.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ConcordSession, type ToolCallRecord } from '../concord/session.ts';
import { sandboxPaths, type SandboxPaths } from '../concord/sandbox.ts';
import {
  applyFix,
  CAJA,
  hasFix,
  REPARTO,
  REVISION,
  requireFix,
  requireTask,
  type Actor,
} from './actors.ts';
import { asArray, asNumber, asString, field } from './json.ts';
import { concordCheck, runFixtureTests } from './probes.ts';
import type {
  ActorId,
  Artifacts,
  Check,
  GuardResult,
  Isolation,
  LaneId,
  LaneOutcome,
  Phase,
  Step,
  TestResult,
} from './types.ts';
import {
  commitShared,
  diffFromBase,
  prepareWorkspace,
  readShared,
  SHARED_FILE,
  writeShared,
} from './workspace.ts';

const NETWORK_MARK = 'RELEVO_NETWORK_BLOCKED';

export interface ScenarioSink {
  step(step: Step): void;
  lane(lane: LaneId, outcome: LaneOutcome): void;
}

export interface ScenarioResult {
  readonly checks: Check[];
  readonly artifacts: Artifacts;
  readonly isolation: Isolation;
}

type StepInput = Omit<Step, 'n' | 'lane' | 'at' | 'phase'>;

class LaneRecorder {
  readonly #lane: LaneId;
  readonly #sink: ScenarioSink;
  readonly #counter: { value: number };
  phase: Phase;

  constructor(lane: LaneId, sink: ScenarioSink, counter: { value: number }) {
    this.phase = lane === 'control' ? 'sin-coordinar' : 'reclamar';
    this.#lane = lane;
    this.#sink = sink;
    this.#counter = counter;
  }

  add(input: StepInput): void {
    this.#counter.value += 1;
    this.#sink.step({
      ...input,
      n: this.#counter.value,
      lane: this.#lane,
      phase: this.phase,
      at: new Date().toISOString(),
    });
  }

  call(actor: ActorId, title: string, detail: string, call: ToolCallRecord): void {
    this.add({ actor, kind: 'concord', title, detail, ok: call.ok, call });
  }

  guard(actor: ActorId, title: string, detail: string, guard: GuardResult, ok: boolean): void {
    this.add({ actor, kind: 'guard', title, detail, ok, guard });
  }

  tests(actor: ActorId, title: string, detail: string, tests: TestResult, ok: boolean): void {
    this.add({ actor, kind: 'tests', title, detail, ok, tests });
  }
}

function testsSummary(tests: TestResult): string {
  return `${String(tests.passed)} de ${String(tests.passed + tests.failed)} pruebas pasan`;
}

/* ------------------------------------------------------------------ control */

async function runControlLane(runDir: string, sink: ScenarioSink, counter: { value: number }) {
  const lane = new LaneRecorder('control', sink, counter);
  const paths = sandboxPaths(join(runDir, 'control'));
  await prepareWorkspace(paths.workspace, paths.home);
  lane.add({
    actor: 'relevo',
    kind: 'session',
    title: 'Repo de La Espiga listo',
    detail: 'Copia limpia con los dos fallos y un commit «base». En este carril no hay Concord.',
    ok: true,
  });

  const cajaCopy = readShared(paths.workspace);
  const repartoCopy = readShared(paths.workspace);
  lane.add({
    actor: 'caja',
    kind: 'read',
    title: 'Caja lee src/totales.js',
    detail: 'Abre el archivo para corregir el cupón.',
    ok: true,
  });
  lane.add({
    actor: 'reparto',
    kind: 'read',
    title: 'Reparto lee el mismo archivo',
    detail: 'Al mismo tiempo, sin saber que Caja está ahí.',
    ok: true,
  });

  const cajaFix = requireFix(CAJA);
  writeShared(paths.workspace, applyFix(cajaCopy, cajaFix));
  await commitShared(paths.workspace, paths.home, 'caja: el cupón no descuenta el envío');
  lane.add({
    actor: 'caja',
    kind: 'edit',
    title: 'Caja guarda su arreglo',
    detail: 'El cupón ya solo descuenta productos.',
    ok: true,
    diff: await diffFromBase(paths.workspace, paths.home),
  });

  const repartoFix = requireFix(REPARTO);
  writeShared(paths.workspace, applyFix(repartoCopy, repartoFix));
  await commitShared(paths.workspace, paths.home, 'reparto: envío gratis desde $500');
  const finalContent = readShared(paths.workspace);
  const cajaSurvived = hasFix(finalContent, cajaFix);
  lane.add({
    actor: 'reparto',
    kind: 'edit',
    title: 'Reparto guarda su copia encima',
    detail: cajaSurvived
      ? 'Ambos arreglos siguen en el archivo.'
      : 'Su copia era anterior al arreglo de Caja: el cupón vuelve a estar roto. Git no se queja.',
    ok: cajaSurvived,
    diff: await diffFromBase(paths.workspace, paths.home),
  });

  const tests = await runFixtureTests(paths);
  lane.tests('relevo', 'Pruebas finales', testsSummary(tests), tests, tests.failed === 0);

  const lostFixes = [CAJA, REPARTO]
    .map((actor) => requireFix(actor))
    .filter((fix) => !hasFix(finalContent, fix))
    .map((fix) => fix.label);
  const outcome: LaneOutcome = {
    tests,
    diff: await diffFromBase(paths.workspace, paths.home),
    lostFixes,
  };
  sink.lane('control', outcome);
  return outcome;
}

/* ------------------------------------------------------------------ concord */

interface ConcordLaneData {
  readonly overlapsAtClaim: number;
  readonly claimAccepted: boolean;
  readonly guardBefore: GuardResult;
  readonly guardAfter: GuardResult;
  readonly promptDelivery: string | undefined;
  readonly promptReadStatus: string | undefined;
  readonly replyReadStatus: string | undefined;
  readonly recoveredUpdates: number;
  readonly recoveredIntent: boolean;
  readonly livenessAfterCrash: string | undefined;
  readonly acceptResults: readonly ToolCallRecord[];
  readonly reviewTests: TestResult;
  readonly outcome: LaneOutcome;
  readonly paths: SandboxPaths;
  readonly sessions: readonly ConcordSession[];
  readonly guards: readonly GuardResult[];
}

async function versionOf(session: ConcordSession, taskId: string, lane: LaneRecorder, actor: Actor) {
  const call = await session.call('inspect_work', { task_id: taskId });
  const version = asNumber(field(call.structured, 'task', 'version'));
  const status = asString(field(call.structured, 'task', 'status'));
  lane.call(
    actor.id,
    `${actor.name} consulta ${taskId}`,
    `Estado ${status ?? '?'}, versión ${String(version ?? '?')}. Las transiciones exigen la versión vigente.`,
    call,
  );
  if (version === undefined) throw new Error(`Concord no devolvió versión para ${taskId}.`);
  return version;
}

function inboxStatus(call: ToolCallRecord, messageId: string | undefined): string | undefined {
  const inbox = asArray(field(call.structured, 'inbox'));
  const found = inbox.find((item) => asString(field(item, 'messageId')) === messageId);
  return asString(field(found, 'status'));
}

async function runConcordLane(
  runDir: string,
  runId: string,
  sink: ScenarioSink,
  counter: { value: number },
): Promise<ConcordLaneData> {
  const lane = new LaneRecorder('concord', sink, counter);
  const scope = join(runDir, 'concord');
  const paths = sandboxPaths(scope);
  await prepareWorkspace(paths.workspace, paths.home);
  const sessions: ConcordSession[] = [];
  const guards: GuardResult[] = [];
  const open = async (actor: Actor) => {
    const session = await ConcordSession.open(actor.id, paths, scope, () => undefined);
    sessions.push(session);
    return session;
  };

  try {
  const caja = await open(CAJA);
  let reparto = await open(REPARTO);
  const tools = await caja.listTools();
  lane.add({
    actor: 'relevo',
    kind: 'session',
    title: 'Mismo repo, ahora con Concord',
    detail: `Cada actor tiene su propio proceso concord-mcp ${'(MCP por stdio)'}. Herramientas anunciadas: ${tools.join(', ')}.`,
    ok: tools.includes('start_work'),
  });

  const cajaTask = requireTask(CAJA);
  const repartoTask = requireTask(REPARTO);
  const scopeArgs = { expected_files: [SHARED_FILE], modules: ['checkout'], domains: ['promociones'] };

  const cajaStart = await caja.call('start_work', {
    task_id: cajaTask.id,
    title: cajaTask.title,
    kind: 'actor-demo',
    owner: 'laboratorio-relevo',
    ...scopeArgs,
  });
  lane.call('caja', 'Caja reclama src/totales.js', 'Declara qué archivo va a tocar antes de editar.', cajaStart);
  const cajaCopy = readShared(paths.workspace);

  const repartoStart = await reparto.call('start_work', {
    task_id: repartoTask.id,
    title: repartoTask.title,
    kind: 'actor-demo',
    owner: 'laboratorio-relevo',
    ...scopeArgs,
  });
  const overlaps = asArray(field(repartoStart.structured, 'overlaps'));
  const firstReasons = asArray(field(overlaps[0], 'reasons')).map((r) => asString(r) ?? '');
  lane.call(
    'reparto',
    overlaps.length > 0 ? 'Concord avisa: choque en el mismo archivo' : 'Reparto reclama sin choque',
    overlaps.length > 0
      ? `Choque con ${asString(field(overlaps[0], 'task_id')) ?? '?'}: ${firstReasons.join('; ')}. Ojo: el reclamo se registra igual; Concord avisa, no bloquea.`
      : 'Concord no reportó choques.',
    repartoStart,
  );

  const guardBefore = await concordCheck(paths, scope, repartoTask.id, SHARED_FILE);
  guards.push(guardBefore);
  lane.guard(
    'reparto',
    guardBefore.exitCode === 1 ? 'La guardia frena a Reparto' : 'La guardia deja pasar a Reparto',
    guardBefore.exitCode === 1
      ? 'concord check sale con código 1. La política del actor: no editar hasta que salga 0.'
      : `concord check salió con ${String(guardBefore.exitCode)}.`,
    guardBefore,
    guardBefore.exitCode === 1,
  );

  lane.phase = 'hablar';
  const prompt = await reparto.call('update_work', {
    operation: 'prompt',
    to_agent_id: CAJA.id,
    task_id: repartoTask.id,
    content:
      'Necesito cambiar la condición de envío gratis en src/totales.js (línea de `envio`). ¿Me avisas cuando liberes el archivo?',
    idempotency_key: `${runId}-reparto-pide-turno`,
  });
  const promptId = asString(field(prompt.structured, 'message_id'));
  const promptDelivery = asString(field(prompt.structured, 'delivery'));
  lane.call(
    'reparto',
    'Reparto le escribe a Caja',
    promptDelivery === 'queued_pull'
      ? 'Mensaje enviado (✓) y en cola: Caja no tiene un adaptador en vivo, lo verá cuando revise su bandeja.'
      : `Entrega: ${promptDelivery ?? 'desconocida'}.`,
    prompt,
  );

  const cajaInbox = await caja.call('inspect_work', { agent_id: CAJA.id });
  const promptReadStatus = inboxStatus(cajaInbox, promptId);
  lane.call(
    'caja',
    'Caja revisa su bandeja',
    `El mensaje de Reparto pasa a «${promptReadStatus ?? '?'}» con hora de lectura registrada.`,
    cajaInbox,
  );

  const reply = await caja.call('update_work', {
    operation: 'reply',
    reply_to_message_id: promptId ?? '',
    content:
      'Va. Termino el cupón, corro pruebas y lo marco listo para revisión; tu prueba de envío seguirá fallando hasta que entre tu cambio.',
    idempotency_key: `${runId}-caja-responde`,
  });
  const replyId = asString(field(reply.structured, 'message_id'));
  lane.call('caja', 'Caja responde', 'La respuesta queda enlazada al mensaje original.', reply);

  const decision = await caja.call('update_work', {
    task_id: cajaTask.id,
    kind: 'decision',
    content: 'El descuento del cupón se calcula solo sobre productos; el envío nunca se descuenta.',
  });
  lane.call('caja', 'Caja deja anotada su decisión', 'Memoria de la tarea: sobrevive a la sesión.', decision);

  lane.phase = 'turnos';
  const cajaFix = requireFix(CAJA);
  writeShared(paths.workspace, applyFix(cajaCopy, cajaFix));
  await commitShared(paths.workspace, paths.home, 'caja: el cupón no descuenta el envío');
  lane.add({
    actor: 'caja',
    kind: 'edit',
    title: 'Caja guarda su arreglo',
    detail: 'Nadie más tocó el archivo mientras lo tenía reclamado.',
    ok: true,
    diff: await diffFromBase(paths.workspace, paths.home),
  });

  const cajaTests = await runFixtureTests(paths);
  lane.tests(
    'caja',
    'Caja corre las pruebas',
    `${testsSummary(cajaTests)}. La que falla es la de envío, que no es suya.`,
    cajaTests,
    cajaTests.cases.some((c) => c.ok && c.name.includes('cupón')),
  );

  const cajaVersion = await versionOf(caja, cajaTask.id, lane, CAJA);
  const cajaFinish = await caja.call('finish_work', {
    task_id: cajaTask.id,
    expected_version: cajaVersion,
    outcome: 'review_ready',
    what_changed: 'El cupón ESPIGA10 descuenta solo el subtotal de productos.',
    changed_files: [SHARED_FILE],
    tests_run: [`${cajaTests.command} → ${testsSummary(cajaTests)}`],
    decisions: ['El envío nunca se descuenta con cupones.'],
    known_risks: ['La prueba de envío gratis sigue fallando: es la tarea T-ENVIO de Reparto.'],
    next_steps: ['Reparto corrige el umbral de envío gratis sobre esta versión.'],
    needs_review_from: [REVISION.id],
  });
  lane.call(
    'caja',
    'Caja marca su parte lista para revisión',
    'finish_work genera el paquete de revisión y libera el archivo.',
    cajaFinish,
  );

  const repartoInbox = await reparto.call('inspect_work', { agent_id: REPARTO.id });
  const replyReadStatus = inboxStatus(repartoInbox, replyId);
  lane.call(
    'reparto',
    'Reparto lee la respuesta',
    `Respuesta de Caja: «${replyReadStatus ?? '?'}».`,
    repartoInbox,
  );

  const guardAfter = await concordCheck(paths, scope, repartoTask.id, SHARED_FILE);
  guards.push(guardAfter);
  lane.guard(
    'reparto',
    guardAfter.exitCode === 0 ? 'La guardia ya deja pasar' : 'La guardia sigue frenando',
    guardAfter.exitCode === 0
      ? 'concord check sale con 0: la tarea de Caja ya no reclama el archivo.'
      : `concord check salió con ${String(guardAfter.exitCode)}.`,
    guardAfter,
    guardAfter.exitCode === 0,
  );

  const intent = await reparto.call('update_work', {
    task_id: repartoTask.id,
    kind: 'intent',
    content:
      'Releer src/totales.js (ya trae el arreglo del cupón) y cambiar `>` por `>=` en el umbral de envío gratis. Prueba objetivo: pedido de exactamente $500.',
  });
  lane.call('reparto', 'Reparto anota su plan', 'Antes de editar deja escrito qué va a hacer.', intent);

  lane.phase = 'caida';
  reparto.crash();
  lane.add({
    actor: 'reparto',
    kind: 'session',
    title: 'Se cae la sesión de Reparto',
    detail: 'Relevo termina su proceso concord-mcp a la fuerza. Lo que tenía en memoria se pierde.',
    ok: true,
  });

  const afterCrash = await caja.call('inspect_work', {});
  const presence = asArray(field(afterCrash.structured, 'presence'));
  const repartoPresence = presence.find((item) => asString(field(item, 'agentId')) === REPARTO.id);
  const livenessAfterCrash = asString(field(repartoPresence, 'liveness'));
  lane.call(
    'caja',
    'Así ve Concord a Reparto tras la caída',
    `Presencia de Reparto: «${livenessAfterCrash ?? '?'}». Concord no detecta caídas al instante: la presencia pasa a inactiva a los 5 min y a ausente a los 30.`,
    afterCrash,
  );

  reparto = await open(REPARTO);
  const resume = await reparto.call('inspect_work', { task_id: repartoTask.id });
  const updates = asArray(field(resume.structured, 'updates'));
  const recoveredIntent = updates.some((u) => asString(field(u, 'kind')) === 'intent');
  const resumeMessages = asArray(field(resume.structured, 'messages'));
  lane.call(
    'reparto',
    'Una sesión nueva de Reparto retoma',
    `Proceso nuevo, misma identidad. Recupera ${String(updates.length)} nota(s) y ${String(resumeMessages.length)} mensaje(s) de la tarea desde Concord.`,
    resume,
  );

  const repartoCopy = readShared(paths.workspace);
  const repartoFix = requireFix(REPARTO);
  writeShared(paths.workspace, applyFix(repartoCopy, repartoFix));
  await commitShared(paths.workspace, paths.home, 'reparto: envío gratis desde $500');
  lane.add({
    actor: 'reparto',
    kind: 'edit',
    title: 'Reparto relee y guarda',
    detail: hasFix(readShared(paths.workspace), cajaFix)
      ? 'Su copia ya traía el arreglo de Caja: los dos cambios conviven.'
      : 'El arreglo de Caja no está en el archivo.',
    ok: hasFix(readShared(paths.workspace), cajaFix),
    diff: await diffFromBase(paths.workspace, paths.home),
  });

  const repartoTests = await runFixtureTests(paths);
  lane.tests('reparto', 'Reparto corre las pruebas', testsSummary(repartoTests), repartoTests, repartoTests.failed === 0);

  lane.phase = 'cierre';
  const revision = await open(REVISION);
  const repartoVersion = await versionOf(reparto, repartoTask.id, lane, REPARTO);
  const offer = await reparto.call('transfer_work', {
    task_id: repartoTask.id,
    action: 'offer',
    to_agent_id: REVISION.id,
    expected_version: repartoVersion,
    what_changed: 'Envío gratis con `>=` en el umbral; incluye el arreglo del cupón de T-CUPON.',
    changed_files: [SHARED_FILE],
    tests_run: [`${repartoTests.command} → ${testsSummary(repartoTests)}`],
    assumptions: ['$500 exactos cuentan como «desde $500».'],
    next_steps: ['Revisión vuelve a correr las pruebas y cierra.'],
  });
  lane.call('reparto', 'Reparto ofrece el relevo a Revisión', 'Handoff con evidencia: qué cambió, pruebas y supuestos.', offer);

  const offeredVersion = asNumber(field(offer.structured, 'version')) ?? repartoVersion + 1;
  const acceptResults = await Promise.all([
    revision.call('transfer_work', { task_id: repartoTask.id, action: 'accept', expected_version: offeredVersion }),
    revision.call('transfer_work', { task_id: repartoTask.id, action: 'accept', expected_version: offeredVersion }),
  ]);
  acceptResults.forEach((call, index) => {
    lane.call(
      'revision',
      call.ok ? 'Revisión acepta el relevo' : 'Un segundo «aceptar» llega tarde',
      call.ok
        ? 'Ahora la tarea es suya.'
        : `Reintento simultáneo (#${String(index + 1)}) con la misma versión. Concord lo rechaza: el traspaso ya no está pendiente.`,
      call,
    );
  });

  const review = await revision.call('inspect_work', { task_id: repartoTask.id });
  const history = asArray(field(review.structured, 'ownership_history'));
  lane.call(
    'revision',
    'Revisión lee todo el contexto',
    `Evidencia del handoff, notas y ${String(history.length)} cambio(s) de dueño en el historial.`,
    review,
  );

  const reviewTests = await runFixtureTests(paths);
  lane.tests('revision', 'Revisión vuelve a correr las pruebas', testsSummary(reviewTests), reviewTests, reviewTests.failed === 0);

  const finding = await revision.call('update_work', {
    task_id: cajaTask.id,
    kind: 'finding',
    content: `Verificado junto con ${repartoTask.id}: ${testsSummary(reviewTests)}.`,
  });
  lane.call('revision', 'Revisión deja un hallazgo en T-CUPON', 'Puede anotar hallazgos en una tarea ajena, no decisiones.', finding);

  const reviewVersion = await versionOf(revision, repartoTask.id, lane, REVISION);
  const close = await revision.call('finish_work', {
    task_id: repartoTask.id,
    expected_version: reviewVersion,
    outcome: 'complete',
    what_changed: 'Revisado: cupón y envío gratis corregidos en src/totales.js.',
    changed_files: [SHARED_FILE],
    tests_run: [`${reviewTests.command} → ${testsSummary(reviewTests)}`],
    reported_outcome: {
      source: 'review',
      acceptance: reviewTests.failed === 0 ? 'accepted' : 'rejected',
      integration: reviewTests.failed === 0 ? 'passed' : 'failed',
    },
    provenance: [{ field: 'reported_outcome', source: `node --test en la corrida ${runId}` }],
  });
  lane.call('revision', 'Revisión cierra T-ENVIO', 'Cierre con resultado medido y su procedencia.', close);

  const finalState = await revision.call('inspect_work', {});
  const reviewReady = asArray(field(finalState.structured, 'review_ready')).length;
  const remaining = asArray(field(finalState.structured, 'overlaps')).length;
  lane.call(
    'relevo',
    'Estado final del workspace',
    `${String(remaining)} choque(s) activo(s); ${String(reviewReady)} tarea(s) «lista para revisión» (T-CUPON: cerrarla le toca a su dueño o a una persona).`,
    finalState,
  );

  const finalContent = readShared(paths.workspace);
  const outcome: LaneOutcome = {
    tests: reviewTests,
    diff: await diffFromBase(paths.workspace, paths.home),
    lostFixes: [CAJA, REPARTO]
      .map((actor) => requireFix(actor))
      .filter((fix) => !hasFix(finalContent, fix))
      .map((fix) => fix.label),
  };
  sink.lane('concord', outcome);

  return {
    overlapsAtClaim: overlaps.length,
    claimAccepted: repartoStart.ok,
    guardBefore,
    guardAfter,
    promptDelivery,
    promptReadStatus,
    replyReadStatus,
    recoveredUpdates: updates.length,
    recoveredIntent,
    livenessAfterCrash,
    acceptResults,
    reviewTests,
    outcome,
    paths,
    sessions,
    guards,
  };
  } finally {
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  }
}

/* ---------------------------------------------------------------- evidence */

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function collectArtifacts(paths: SandboxPaths): Artifacts {
  const dir = join(paths.workspace, '.concord');
  const events = readIfExists(join(dir, 'events.jsonl'));
  const workState = readIfExists(join(dir, 'WORK_STATE.json'));
  return {
    handoffMd: readIfExists(join(dir, 'HANDOFF.md')),
    reviewPacketMd: readIfExists(join(dir, 'REVIEW_PACKET.md')),
    workStateSummary: workState === null ? null : workState.slice(0, 4000),
    eventsCount: events === null ? 0 : events.split('\n').filter((line) => line.trim() !== '').length,
  };
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/gu, '/'));
}

function collectIsolation(data: ConcordLaneData): Isolation {
  const lines = [
    ...data.sessions.flatMap((session) => session.stderrLines),
    ...data.guards.flatMap((guard) => guard.output.split(/\r?\n/u)),
  ];
  return {
    networkAttempts: lines.filter((line) => line.includes(NETWORK_MARK)),
    homeFiles: listFiles(data.paths.home).filter((file) => file !== '.gitconfig-relevo'),
    concordProcesses: data.sessions.length + data.guards.length,
  };
}

function buildChecks(control: LaneOutcome, data: ConcordLaneData, isolation: Isolation): Check[] {
  const accepted = data.acceptResults.filter((call) => call.ok).length;
  const rejected = data.acceptResults.find((call) => !call.ok);
  const controlTests = control.tests;
  return [
    {
      id: 'control-pierde-cambio',
      label: 'Sin coordinar, un arreglo se pierde sin que git avise',
      passed: control.lostFixes.length > 0 && controlTests !== null && controlTests.failed > 0,
      detail: `Perdido: ${control.lostFixes.join(', ') || 'nada'}. Pruebas: ${controlTests === null ? '?' : testsSummary(controlTests)}.`,
    },
    {
      id: 'concord-detecta-choque',
      label: 'Concord detecta el choque al reclamar',
      passed: data.overlapsAtClaim > 0,
      detail: `${String(data.overlapsAtClaim)} choque(s) reportado(s) por start_work.`,
    },
    {
      id: 'concord-no-bloquea',
      label: 'El aviso no es un candado: el reclamo con choque se acepta',
      passed: data.claimAccepted && data.overlapsAtClaim > 0,
      detail: 'Evitar la edición depende de la guardia (concord check) y de la política del agente.',
    },
    {
      id: 'guardia',
      label: 'concord check frena antes y libera después',
      passed: data.guardBefore.exitCode === 1 && data.guardAfter.exitCode === 0,
      detail: `Códigos de salida: ${String(data.guardBefore.exitCode)} → ${String(data.guardAfter.exitCode)}.`,
    },
    {
      id: 'mensajes',
      label: 'Mensaje y respuesta llegan con acuse de lectura',
      passed: data.promptReadStatus === 'read' && data.replyReadStatus === 'read',
      detail: `Entrega «${data.promptDelivery ?? '?'}» (cola, no push); estados: ${data.promptReadStatus ?? '?'} / ${data.replyReadStatus ?? '?'}.`,
    },
    {
      id: 'recuperacion',
      label: 'Tras la caída, la nueva sesión recupera el plan',
      passed: data.recoveredIntent,
      detail: `${String(data.recoveredUpdates)} nota(s) recuperada(s). Presencia tras la caída: «${data.livenessAfterCrash ?? '?'}».`,
    },
    {
      id: 'traspaso-duplicado',
      label: 'Un «aceptar» duplicado no duplica el traspaso',
      passed: accepted === 1 && rejected !== undefined,
      detail: rejected === undefined ? 'No hubo rechazo.' : rejected.text.split('\n').at(-1) ?? '',
    },
    {
      id: 'concord-todo-verde',
      label: 'Con Concord, ambos arreglos sobreviven y las pruebas pasan',
      passed: data.outcome.lostFixes.length === 0 && data.reviewTests.failed === 0,
      detail: testsSummary(data.reviewTests),
    },
    {
      id: 'aislamiento',
      label: 'Sin red y sin tocar el HOME real',
      passed: isolation.networkAttempts.length === 0 && isolation.homeFiles.length === 0,
      detail: `${String(isolation.concordProcesses)} procesos de Concord; ${String(isolation.networkAttempts.length)} intentos de red; ${String(isolation.homeFiles.length)} archivo(s) en el HOME falso.`,
    },
  ];
}

export async function runScenario(runDir: string, runId: string, sink: ScenarioSink): Promise<ScenarioResult> {
  mkdirSync(runDir, { recursive: true });
  const counter = { value: 0 };
  const control = await runControlLane(runDir, sink, counter);
  const data = await runConcordLane(runDir, runId, sink, counter);
  const isolation = collectIsolation(data);
  return {
    checks: buildChecks(control, data, isolation),
    artifacts: collectArtifacts(data.paths),
    isolation,
  };
}
