// @ts-check
import {
  formatWhen,
  h,
  PHASES,
  renderArtifacts,
  renderChecks,
  renderScoreboard,
  renderStep,
} from './render.js';

/**
 * @typedef {import('./render.js').Run} Run
 * @typedef {import('./render.js').Step} Step
 * @typedef {{ id: string, source: string, status: string, startedAt: string, checksPassed: number, checksTotal: number }} RunSummary
 * @typedef {{ name: string, id: string, startedAt: string }} Capture
 * @typedef {{ concordVersion: string, node: string, platform: string, readOnly: boolean, running: string | null, runs: RunSummary[], captures: Capture[] }} Status
 * @typedef {{ kind: 'run', id: string } | { kind: 'capture', name: string }} View
 */

/** @template {HTMLElement} T @param {string} id @param {new () => T} type @returns {T} */
function byId(id, type) {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Falta #${id}`);
  return el;
}

const ui = {
  meta: byId('meta-version', HTMLElement),
  runButton: byId('run-button', HTMLButtonElement),
  captureButton: byId('capture-button', HTMLButtonElement),
  hint: byId('run-hint', HTMLElement),
  banner: byId('banner', HTMLElement),
  results: byId('results', HTMLElement),
  runInfo: byId('run-info', HTMLElement),
  picker: byId('picker', HTMLElement),
  select: byId('run-select', HTMLSelectElement),
  live: byId('live', HTMLElement),
  scoreboard: byId('scoreboard', HTMLElement),
  control: byId('control-steps', HTMLElement),
  concord: byId('concord-steps', HTMLElement),
  checks: byId('checks', HTMLElement),
  artifacts: byId('artifacts', HTMLElement),
  artifactsNote: byId('artifacts-note', HTMLElement),
  resetButton: byId('reset-button', HTMLButtonElement),
  resetDialog: byId('reset-dialog', HTMLDialogElement),
  resetCancel: byId('reset-cancel', HTMLButtonElement),
  resetConfirm: byId('reset-confirm', HTMLButtonElement),
};

/** @type {{ status: Status | null, view: View | null, renderedId: string | null, renderedSteps: number, lastPhase: string | null, pollTimer: number | null }} */
const state = { status: null, view: null, renderedId: null, renderedSteps: 0, lastPhase: null, pollTimer: null };

/* ------------------------------------------------------------------- red */

/** @param {string} path @param {RequestInit} [init] */
async function api(path, init) {
  const response = await fetch(path, {
    ...init,
    headers: { 'x-relevo-intent': '1', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(8_000),
  });
  /** @type {unknown} */
  const body = await response.json().catch(() => null);
  return { response, body };
}

/** @param {unknown} body @param {string} fallback */
function errorText(body, fallback) {
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback;
}

/* --------------------------------------------------------------- avisos */

/** @param {string} message @param {{ tone?: 'error' | 'info', retry?: () => void }} [options] */
function showBanner(message, options = {}) {
  ui.banner.replaceChildren(h('p', { text: message }));
  ui.banner.dataset['tone'] = options.tone ?? 'error';
  ui.banner.setAttribute('role', options.tone === 'info' ? 'status' : 'alert');
  if (options.retry) {
    const retry = options.retry;
    const button = h('button', { className: 'btn btn--ghost', text: 'Reintentar', attrs: { type: 'button' } });
    button.addEventListener('click', () => {
      hideBanner();
      retry();
    });
    ui.banner.append(button);
  }
  ui.banner.hidden = false;
}

function hideBanner() {
  ui.banner.hidden = true;
  ui.banner.replaceChildren();
}

/** @param {string} text */
function announce(text) {
  ui.live.textContent = text;
}

/* --------------------------------------------------------------- estado */

async function refreshStatus() {
  const { response, body } = await api('/api/status');
  if (!response.ok || body === null || typeof body !== 'object') throw new Error('status');
  const status = /** @type {Status} */ (body);
  state.status = status;
  ui.meta.textContent = `laboratorio local · Concord MCP ${status.concordVersion} · Node ${status.node}`;
  ui.captureButton.hidden = status.captures.length === 0;
  if (status.readOnly) {
    ui.runButton.disabled = true;
    ui.hint.textContent = 'Este servidor está en modo repetición: muestra corridas reales capturadas, no lanza nuevas.';
  }
  fillPicker(status);
  return status;
}

/** @param {Status} status */
function fillPicker(status) {
  const options = [
    ...status.runs.map((run) =>
      h('option', {
        text: `${formatWhen(run.startedAt)} · ${run.status === 'running' ? 'en curso' : run.status === 'failed' ? 'falló' : `${String(run.checksPassed)}/${String(run.checksTotal)} comprobaciones`}`,
        attrs: { value: `run:${run.id}` },
      }),
    ),
    ...status.captures.map((capture) =>
      h('option', { text: `Captura · ${formatWhen(capture.startedAt)}`, attrs: { value: `capture:${capture.name}` } }),
    ),
  ];
  ui.select.replaceChildren(...options);
  ui.picker.hidden = options.length < 2;
  if (state.view) ui.select.value = viewKey(state.view);
}

/** @param {View} view */
function viewKey(view) {
  return view.kind === 'run' ? `run:${view.id}` : `capture:${view.name}`;
}

/* ---------------------------------------------------------------- vista */

/** @param {View} view */
async function show(view) {
  stopPolling();
  state.view = view;
  ui.select.value = viewKey(view);
  const path = view.kind === 'run' ? `/api/runs/${encodeURIComponent(view.id)}` : `/api/captures/${encodeURIComponent(view.name)}`;
  const { response, body } = await api(path);
  if (!response.ok) {
    showBanner(errorText(body, 'No pude cargar esa corrida.'));
    return;
  }
  const run = /** @type {Run} */ (body);
  render(run);
  if (run.status === 'running') schedulePoll(view);
}

/** @param {View} view */
function schedulePoll(view, failures = 0) {
  state.pollTimer = window.setTimeout(async () => {
    if (state.view === null || viewKey(state.view) !== viewKey(view)) return;
    try {
      const path = view.kind === 'run' ? `/api/runs/${encodeURIComponent(view.id)}` : '';
      const { response, body } = await api(path);
      if (!response.ok) throw new Error('poll');
      const run = /** @type {Run} */ (body);
      render(run);
      if (run.status === 'running') schedulePoll(view);
      else finishRunning(run);
    } catch {
      if (failures >= 6) {
        setRunning(false);
        showBanner('Perdí contacto con el servidor de Relevo durante la corrida.', { retry: () => void show(view) });
      } else {
        schedulePoll(view, failures + 1);
      }
    }
  }, 350);
}

function stopPolling() {
  if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

/** @param {Run} run */
function finishRunning(run) {
  setRunning(false);
  if (run.status === 'failed') {
    showBanner(`La corrida falló: ${run.error ?? 'error desconocido'}`, { retry: () => void startRun() });
    announce('La corrida falló.');
  } else {
    const passed = run.checks.filter((check) => check.passed).length;
    announce(`Corrida terminada. ${String(passed)} de ${String(run.checks.length)} comprobaciones se cumplieron.`);
  }
  void refreshStatus().catch(() => undefined);
}

/** @param {Run} run */
function renderInfo(run) {
  const source = run.source === 'capture' ? 'capture' : 'live';
  const tag = h('span', {
    className: 'tag',
    text: source === 'capture' ? 'Repetición' : run.status === 'running' ? 'En vivo' : 'Corrida local',
    attrs: { 'data-source': source },
  });
  const when = formatWhen(run.startedAt);
  const text =
    source === 'capture'
      ? `Corrida real capturada el ${when} (${run.id}). Ahora no se está ejecutando nada.`
      : run.status === 'running'
        ? `Ejecutándose ahora · ${String(run.steps.length)} pasos hasta el momento`
        : `${when} · ${run.id}`;
  const env = ` · Concord ${run.environment.concordVersion} · Node ${run.environment.node} · ${run.environment.platform}`;
  ui.runInfo.replaceChildren(tag, text, env);
}

/** @param {Step} step */
function chapterFor(step) {
  const id = `chapter-${step.phase}`;
  const existing = document.getElementById(id);
  if (existing) {
    const list = existing.querySelector('ol');
    if (list) return list;
  }
  const keys = Object.keys(PHASES);
  const list = h('ol', { className: 'timeline' });
  const section = h(
    'section',
    { className: 'chapter', attrs: { id, 'aria-labelledby': `${id}-title` } },
    h(
      'h4',
      { attrs: { id: `${id}-title` } },
      h('span', { className: 'num', text: String(keys.indexOf(step.phase) + 1) }),
      PHASES[step.phase] ?? step.phase,
    ),
    list,
  );
  ui.concord.append(section);
  return list;
}

/** @param {Run} run */
function render(run) {
  ui.results.hidden = false;
  if (state.renderedId !== run.id) {
    state.renderedId = run.id;
    state.renderedSteps = 0;
    state.lastPhase = null;
    ui.control.replaceChildren();
    ui.concord.replaceChildren();
  }
  renderInfo(run);

  for (const step of run.steps.slice(state.renderedSteps)) {
    const item = renderStep(step);
    if (step.lane === 'control') ui.control.append(item);
    else chapterFor(step).append(item);
    if (run.status === 'running' && step.phase !== state.lastPhase) {
      announce(step.lane === 'control' ? 'Carril sin coordinar en marcha.' : `Con Concord: ${PHASES[step.phase] ?? step.phase}.`);
    }
    state.lastPhase = step.phase;
  }
  state.renderedSteps = run.steps.length;

  ui.scoreboard.replaceChildren(...renderScoreboard(run));
  ui.checks.replaceChildren(
    ...(run.checks.length > 0
      ? renderChecks(run.checks)
      : [h('li', { className: 'muted', text: run.status === 'running' ? 'Se calculan al terminar la corrida.' : 'Sin comprobaciones.' })]),
  );
  if (run.artifacts) {
    ui.artifactsNote.textContent = `Archivos que Concord generó en .concord/ (${String(run.artifacts.eventsCount)} eventos en events.jsonl). Son su memoria legible para personas y PRs.`;
    ui.artifacts.replaceChildren(...renderArtifacts(run.artifacts));
  } else {
    ui.artifactsNote.textContent = run.status === 'running' ? 'Aparecen al terminar.' : '';
    ui.artifacts.replaceChildren();
  }
}

/* -------------------------------------------------------------- acciones */

/** @param {boolean} running */
function setRunning(running) {
  ui.runButton.setAttribute('aria-busy', String(running));
  ui.runButton.disabled = running || (state.status?.readOnly ?? false);
  const label = ui.runButton.querySelector('.btn__label');
  if (label) {
    const hasRuns = (state.status?.runs.length ?? 0) > 0;
    label.textContent = running ? 'Corriendo…' : hasRuns ? 'Correr otra vez' : 'Correr el laboratorio';
  }
}

async function startRun() {
  hideBanner();
  setRunning(true);
  announce('Arrancando la corrida real.');
  try {
    const { response, body } = await api('/api/runs', { method: 'POST' });
    if (response.status === 409 && typeof body === 'object' && body !== null && 'running' in body && typeof body.running === 'string') {
      await show({ kind: 'run', id: body.running });
      return;
    }
    if (!response.ok || typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string') {
      setRunning(false);
      showBanner(errorText(body, 'No se pudo arrancar la corrida.'));
      return;
    }
    await refreshStatus().catch(() => undefined);
    await show({ kind: 'run', id: body.id });
    ui.results.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch {
    setRunning(false);
    showBanner('No pude hablar con el servidor de Relevo. ¿Sigue abierto «npm start»?', { retry: () => void startRun() });
  }
}

ui.runButton.addEventListener('click', () => void startRun());

ui.captureButton.addEventListener('click', () => {
  const capture = state.status?.captures[0];
  if (capture) void show({ kind: 'capture', name: capture.name }).then(() => ui.results.scrollIntoView({ block: 'start' }));
});

ui.select.addEventListener('change', () => {
  const [kind, ...rest] = ui.select.value.split(':');
  const value = rest.join(':');
  if (kind === 'run') void show({ kind: 'run', id: value });
  if (kind === 'capture') void show({ kind: 'capture', name: value });
});

ui.resetButton.addEventListener('click', () => ui.resetDialog.showModal());
ui.resetCancel.addEventListener('click', () => ui.resetDialog.close());
ui.resetConfirm.addEventListener('click', async () => {
  ui.resetDialog.close();
  const { response, body } = await api('/api/runs', { method: 'DELETE' }).catch(() => ({ response: null, body: null }));
  if (!response?.ok) {
    showBanner(errorText(body, 'No se pudieron borrar las corridas.'));
    return;
  }
  showBanner('Corridas locales borradas.', { tone: 'info' });
  if (state.view?.kind === 'run') {
    state.view = null;
    state.renderedId = null;
    ui.results.hidden = true;
  }
  const status = await refreshStatus().catch(() => null);
  const capture = status?.captures[0];
  if (capture && state.view === null) void show({ kind: 'capture', name: capture.name });
});

/* ----------------------------------------------------------------- inicio */

async function boot() {
  try {
    const status = await refreshStatus();
    if (status.running) {
      setRunning(true);
      await show({ kind: 'run', id: status.running });
      return;
    }
    const latest = status.runs.find((run) => run.status !== 'running');
    if (latest) {
      setRunning(false);
      await show({ kind: 'run', id: latest.id });
    } else if (status.captures[0]) {
      await show({ kind: 'capture', name: status.captures[0].name });
    }
  } catch {
    showBanner('No pude hablar con el servidor de Relevo. ¿Sigue abierto «npm start»?', { retry: () => void boot() });
  }
}

void boot();
