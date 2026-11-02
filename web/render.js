// @ts-check
/**
 * Construcción del DOM a partir de una corrida. Todo el texto entra con
 * `textContent`: las respuestas de Concord se muestran, nunca se interpretan.
 */

/**
 * @typedef {{ name: string, ok: boolean, reason: string | null }} TestCase
 * @typedef {{ command: string, exitCode: number | null, passed: number, failed: number, cases: TestCase[], durationMs: number }} TestResult
 * @typedef {{ command: string, exitCode: number | null, output: string }} GuardResult
 * @typedef {{ agentId: string, tool: string, args: unknown, ok: boolean, text: string, structured: unknown, durationMs: number, at: string }} ToolCall
 * @typedef {{ n: number, lane: 'control' | 'concord', phase: string, actor: string, kind: string, title: string, detail: string, ok: boolean, at: string, call?: ToolCall, guard?: GuardResult, tests?: TestResult, diff?: string }} Step
 * @typedef {{ tests: TestResult | null, diff: string, lostFixes: string[] }} LaneOutcome
 * @typedef {{ id: string, label: string, passed: boolean, detail: string }} Check
 * @typedef {{ handoffMd: string | null, reviewPacketMd: string | null, workStateSummary: string | null, eventsCount: number }} Artifacts
 * @typedef {{ networkAttempts: string[], homeFiles: string[], concordProcesses: number }} Isolation
 * @typedef {{ id: string, source: 'live' | 'capture', status: 'running' | 'done' | 'failed', startedAt: string, finishedAt: string | null, environment: { concordVersion: string, node: string, platform: string }, steps: Step[], lanes: { control?: LaneOutcome, concord?: LaneOutcome }, checks: Check[], artifacts: Artifacts | null, isolation: Isolation | null, error: string | null }} Run
 */

export const ACTOR_NAMES = /** @type {Record<string, string>} */ ({
  caja: 'Caja',
  reparto: 'Reparto',
  revision: 'Revisión',
  relevo: 'Laboratorio',
});

const ACTOR_INITIALS = /** @type {Record<string, string>} */ ({
  caja: 'C',
  reparto: 'R',
  revision: 'V',
  relevo: '◆',
});

export const PHASES = /** @type {Record<string, string>} */ ({
  reclamar: 'Reclamar antes de tocar',
  hablar: 'Hablar en lugar de adivinar',
  turnos: 'Trabajar por turnos',
  caida: 'Caerse y retomar',
  cierre: 'Pasar el relevo y cerrar',
});

const TOOL_LABELS = /** @type {Record<string, string>} */ ({
  start_work: 'start_work',
  inspect_work: 'inspect_work',
  update_work: 'update_work',
  transfer_work: 'transfer_work',
  finish_work: 'finish_work',
});

/**
 * @param {string} tag
 * @param {{ className?: string, text?: string, attrs?: Record<string, string> }} [props]
 * @param {(Node | string | null | undefined | false)[]} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props.className) el.className = props.className;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) el.setAttribute(key, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** @param {string} actor */
function avatar(actor) {
  return h('span', {
    className: 'avatar',
    text: ACTOR_INITIALS[actor] ?? '·',
    attrs: { 'data-actor': actor, 'aria-hidden': 'true' },
  });
}

/** @param {string} text @param {'ok' | 'bad' | undefined} [tone] */
function badge(text, tone) {
  return h('span', { className: 'badge', text, attrs: tone ? { 'data-tone': tone } : {} });
}

/** @param {string} label @param {string} text @param {string} [className] */
function rawBlock(label, text, className) {
  return [
    h('p', { className: 'raw__label', text: label }),
    h('pre', className ? { className } : {}, text),
  ];
}

/** @param {string} diff */
function diffBlock(diff) {
  const pre = h('pre', { className: 'diff' });
  const lines = diff.split('\n').filter((line) => !/^(diff --git|index |--- |\+\+\+ )/u.test(line));
  for (const line of lines) {
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    pre.append(h('span', { className: kind, text: line || ' ' }));
  }
  return pre;
}

/** @param {TestCase[]} cases */
export function caseList(cases) {
  return h(
    'ul',
    { className: 'cases' },
    ...cases.map((testCase) =>
      h(
        'li',
        { className: 'case', attrs: { 'data-ok': String(testCase.ok) } },
        h('span', { className: 'case__icon', text: testCase.ok ? '✓' : '✗', attrs: { 'aria-hidden': 'true' } }),
        h('span', {}, h('span', { className: 'sr-only', text: testCase.ok ? 'Pasa: ' : 'Falla: ' }), testCase.name),
        testCase.reason ? h('p', { className: 'case__reason', text: testCase.reason }) : null,
      ),
    ),
  );
}

/** @param {unknown} value */
function pretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** @param {string} text @param {number} max */
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n… (${String(text.length - max)} caracteres más)` : text;
}

/** @param {Step} step */
function stepBadges(step) {
  const badges = [];
  if (step.call) {
    badges.push(badge(TOOL_LABELS[step.call.tool] ?? step.call.tool));
    badges.push(badge(`${String(step.call.durationMs)} ms`));
    if (!step.call.ok) badges.push(badge('rechazado por Concord', 'bad'));
  }
  if (step.guard) {
    badges.push(badge('concord check'));
    badges.push(badge(`salida ${String(step.guard.exitCode)}`, step.guard.exitCode === 0 ? 'ok' : 'bad'));
  }
  if (step.tests) {
    const total = step.tests.passed + step.tests.failed;
    badges.push(badge(`${String(step.tests.passed)}/${String(total)} pruebas`, step.tests.failed === 0 ? 'ok' : 'bad'));
  }
  if (step.kind === 'edit') badges.push(badge('git commit'));
  return badges.length > 0 ? h('div', { className: 'step__badges' }, ...badges) : null;
}

/** @param {Step} step */
function stepRaw(step) {
  /** @type {HTMLElement[]} */
  let body = [];
  let label = 'Ver lo que respondió Concord';
  if (step.call) {
    body = [
      ...rawBlock('Llamada', `${step.call.tool} · actor ${step.call.agentId}`),
      ...rawBlock('Argumentos', clip(pretty(step.call.args), 3000)),
      ...rawBlock(step.call.ok ? 'Respuesta (texto)' : 'Error devuelto', clip(step.call.text, 3000)),
    ];
    if (step.call.structured !== null && step.call.structured !== undefined) {
      body.push(...rawBlock('Respuesta (estructurada)', clip(pretty(step.call.structured), 6000)));
    }
  } else if (step.guard) {
    label = 'Ver la salida del comando';
    body = [...rawBlock('Comando', step.guard.command), ...rawBlock(`Salida (código ${String(step.guard.exitCode)})`, step.guard.output || '(vacía)')];
  } else if (step.diff) {
    label = 'Ver el cambio en src/totales.js';
    body = [h('p', { className: 'raw__label', text: 'Diff contra la versión inicial' }), diffBlock(step.diff)];
  } else if (step.tests) {
    label = step.lane === 'control' ? 'Ver qué pruebas fallaron' : 'Ver el comando de pruebas';
    body = step.lane === 'control' ? [caseList(step.tests.cases), ...rawBlock('Comando', step.tests.command)] : rawBlock('Comando', `${step.tests.command} · ${String(step.tests.durationMs)} ms · salida ${String(step.tests.exitCode)}`);
  } else {
    return null;
  }
  const details = h('details', { className: 'raw' }, h('summary', { text: label }), ...body);
  if (step.diff && !step.ok) details.setAttribute('open', '');
  return details;
}

/** @param {Step} step */
export function renderStep(step) {
  const actorName = ACTOR_NAMES[step.actor] ?? step.actor;
  return h(
    'li',
    { attrs: { 'data-n': String(step.n) } },
    h(
      'article',
      { className: 'step', attrs: { 'data-actor': step.actor, 'data-ok': String(step.ok), 'aria-label': `Paso ${String(step.n)}: ${step.title}` } },
      h(
        'div',
        { className: 'step__top' },
        avatar(step.actor),
        h('span', { className: 'step__title' }, h('span', { className: 'sr-only', text: `${actorName}. ` }), step.title),
        h('span', { className: 'step__n', text: `#${String(step.n)}` }),
      ),
      h('p', { className: 'step__detail', text: step.detail }),
      stepBadges(step),
      step.tests && step.lane === 'concord' ? caseList(step.tests.cases) : null,
      stepRaw(step),
    ),
  );
}

/**
 * @param {string} title
 * @param {LaneOutcome | undefined} outcome
 * @param {'control' | 'concord'} lane
 * @param {boolean} running
 */
function scoreCard(title, outcome, lane, running) {
  const tests = outcome?.tests ?? null;
  if (!tests) {
    return h(
      'article',
      { className: 'score' },
      h('p', { className: 'score__label', text: title }),
      h('p', { className: 'score__big score__pending', text: running ? '…' : '—' }),
      h('p', { className: 'score__verdict score__pending', text: running ? 'Corriendo este carril…' : 'Sin resultado.' }),
    );
  }
  const total = tests.passed + tests.failed;
  const lost = outcome?.lostFixes ?? [];
  const good = tests.failed === 0 && lost.length === 0;
  const verdict = lost.length > 0 ? `Se perdió: ${lost.join(', ')}` : good ? 'Ningún arreglo perdido' : 'Hay pruebas fallando';
  return h(
    'article',
    { className: 'score', attrs: { 'data-tone': good ? 'ok' : 'bad', 'data-lane': lane } },
    h('p', { className: 'score__label', text: title }),
    h('p', { className: 'score__big' }, `${String(tests.passed)}/${String(total)}`, h('small', { text: 'pruebas pasan' })),
    h('p', { className: 'score__verdict', text: verdict }),
    caseList(tests.cases.map((c) => ({ ...c, reason: null }))),
  );
}

/** @param {Run} run */
export function renderScoreboard(run) {
  const running = run.status === 'running';
  return [
    scoreCard('Sin coordinar', run.lanes.control, 'control', running),
    scoreCard('Con Concord', run.lanes.concord, 'concord', running),
  ];
}

/** @param {Check[]} checks */
export function renderChecks(checks) {
  return checks.map((check) =>
    h(
      'li',
      { className: 'check', attrs: { 'data-passed': String(check.passed) } },
      h('span', { className: 'check__icon', text: check.passed ? '✓' : '!', attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        {},
        h('strong', {}, h('span', { className: 'sr-only', text: check.passed ? 'Se cumplió: ' : 'No se cumplió: ' }), check.label),
        h('p', { text: check.detail }),
      ),
    ),
  );
}

/** @param {Artifacts} artifacts */
export function renderArtifacts(artifacts) {
  const panels = [];
  if (artifacts.reviewPacketMd) {
    panels.push(h('section', { className: 'artifact' }, h('h4', { text: '.concord/REVIEW_PACKET.md' }), h('pre', { text: artifacts.reviewPacketMd })));
  }
  if (artifacts.handoffMd) {
    panels.push(h('section', { className: 'artifact' }, h('h4', { text: '.concord/HANDOFF.md' }), h('pre', { text: artifacts.handoffMd })));
  }
  if (panels.length === 0) panels.push(h('p', { className: 'muted', text: 'Esta corrida no dejó artefactos.' }));
  return panels;
}

/** @param {string} iso */
export function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
