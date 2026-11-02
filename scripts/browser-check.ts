/**
 * Recorre la app en un navegador real (Edge o Chrome instalados, perfil
 * temporal, sin descargas) contra un servidor propio en un puerto aparte y con
 * una carpeta de datos desechable. Guarda capturas y un resumen en
 * docs/evidencias/. Uso: npm run browser-check
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(appRoot, 'docs', 'evidencias');
const shots = join(evidence, 'capturas');
const dataDir = join(appRoot, 'data', 'browser-check');
const port = 4391;
const base = `http://localhost:${String(port)}`;

interface Result {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✓' : '✗'} ${name} — ${detail}\n`);
}

function startServer(): Promise<ChildProcess> {
  rmSync(dataDir, { recursive: true, force: true });
  const child = spawn(process.execPath, ['server/main.ts'], {
    cwd: appRoot,
    env: { ...process.env, RELEVO_PORT: String(port), RELEVO_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El servidor no arrancó.')), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Relevo listo')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', () => reject(new Error('El servidor terminó antes de tiempo.')));
  });
}

async function launch(): Promise<Browser> {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // probar el siguiente navegador instalado
    }
  }
  throw new Error('No encontré Edge ni Chrome instalados.');
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function main() {
  mkdirSync(shots, { recursive: true });
  let server = await startServer();
  const browser = await launch();
  try {
    /* -------------------------------------------- escritorio, repetición */
    const desktop = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'es-MX' });
    const page = await desktop.newPage();
    const errors = watchErrors(page);
    await page.goto(base);
    await page.locator('.runinfo .tag').waitFor();
    const tag = await page.locator('.runinfo .tag').textContent();
    record('Abre con la repetición capturada', tag === 'Repetición', `Etiqueta: ${tag ?? '(ninguna)'}`);
    await page.screenshot({ path: join(shots, '01-inicio.png') });

    const firstFocus = await page.keyboard.press('Tab').then(() => page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''));
    record('El primer Tab llega al enlace para saltar', firstFocus === 'Saltar al contenido', firstFocus);

    /* ------------------------------------------- escritorio, corrida real */
    await page.getByRole('button', { name: /Correr el laboratorio/u }).click();
    await page.locator('.runinfo .tag', { hasText: 'En vivo' }).waitFor({ timeout: 10_000 });
    await page.locator('#chapter-reclamar').waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(shots, '02-corriendo.png') });
    await page.locator('.check').nth(8).waitFor({ timeout: 60_000 });
    const tagAfter = await page.locator('.runinfo .tag').textContent();
    const checks = await page.locator('.check').count();
    const passed = await page.locator('.check[data-passed="true"]').count();
    record('La corrida real termina en la página', tagAfter === 'Corrida local', `Etiqueta final: ${tagAfter ?? '?'}`);
    record('Comprobaciones de la corrida', checks === 9 && passed === 9, `${String(passed)}/${String(checks)} cumplidas`);
    const control = await page.locator('.score[data-lane="control"] .score__big').textContent();
    const concord = await page.locator('.score[data-lane="concord"] .score__big').textContent();
    record('Marcador: sin coordinar pierde, con Concord no', Boolean(control?.startsWith('3/4')) && Boolean(concord?.startsWith('4/4')), `${control ?? '?'} vs ${concord ?? '?'}`);
    const steps = await page.locator('.step').count();
    record('Se ven todos los pasos', steps >= 30, `${String(steps)} pasos en la línea de tiempo`);
    await page.screenshot({ path: join(shots, '03-resultado-completo.png'), fullPage: true });

    const overlapStep = page.locator('.step', { hasText: 'Concord avisa: choque' });
    await overlapStep.locator('summary').click();
    await overlapStep.screenshot({ path: join(shots, '04-respuesta-real-del-choque.png') });
    const raw = await overlapStep.locator('pre').allTextContents();
    record('El detalle muestra la respuesta real de Concord', raw.some((text) => text.includes('same file(s): src/totales.js')), 'Texto contiene «same file(s): src/totales.js»');
    await page.locator('.scoreboard').screenshot({ path: join(shots, '05-marcador.png') });
    await page.locator('#chapter-caida').screenshot({ path: join(shots, '06-caida-y-recuperacion.png') });
    await page.locator('.lane--control').screenshot({ path: join(shots, '11-carril-sin-coordinar.png') });
    await page.locator('.checks').screenshot({ path: join(shots, '12-comprobaciones.png') });

    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button, a, select')].filter((el) => {
        const label = el.getAttribute('aria-label') ?? el.textContent ?? '';
        const labelled = el.closest('label') !== null;
        return label.trim() === '' && !labelled;
      }).length,
    );
    record('Todos los controles tienen nombre accesible', unnamed === 0, `${String(unnamed)} sin nombre`);
    const h1 = await page.locator('h1').count();
    record('Un solo h1 y landmarks principales', h1 === 1 && (await page.locator('main, header, footer').count()) >= 3, `h1: ${String(h1)}`);

    /* ---------------------------------------------------- reiniciar datos */
    await page.getByRole('button', { name: 'Borrar corridas locales' }).click();
    await page.getByRole('button', { name: 'Borrar', exact: true }).click();
    await page.locator('#banner', { hasText: 'Corridas locales borradas' }).waitFor();
    await page.locator('.runinfo .tag', { hasText: 'Repetición' }).waitFor();
    record('Borrar corridas vuelve a la repetición', true, 'Aviso visible y vista de captura');
    record('Sin errores en consola', errors.length === 0, errors.join(' | ') || 'ninguno');
    await desktop.close();

    /* --------------------------------------------------------------- móvil */
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-MX' });
    const phone = await mobile.newPage();
    await phone.goto(base);
    await phone.locator('.runinfo .tag').waitFor();
    await phone.screenshot({ path: join(shots, '07-movil-inicio.png') });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    record('Sin desbordamiento horizontal en móvil', overflow <= 1, `${String(overflow)} px extra`);
    await phone.locator('.scoreboard').scrollIntoViewIfNeeded();
    await phone.screenshot({ path: join(shots, '08-movil-resultados.png') });
    await mobile.close();

    /* ------------------------------------------------------- modo oscuro */
    const dark = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark', locale: 'es-MX' });
    const night = await dark.newPage();
    await night.goto(base);
    await night.locator('.runinfo .tag').waitFor();
    await night.screenshot({ path: join(shots, '09-modo-oscuro.png') });
    await dark.close();

    /* ------------------------------------------------- servidor caído */
    const failing = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'es-MX' });
    const down = await failing.newPage();
    await down.goto(base);
    await down.locator('.runinfo .tag').waitFor();
    server.kill();
    await down.getByRole('button', { name: /Correr/u }).click();
    await down.locator('#banner', { hasText: 'No pude hablar con el servidor' }).waitFor({ timeout: 20_000 });
    await down.locator('#banner').screenshot({ path: join(shots, '10-error-servidor.png') });
    record('Error visible si el servidor no responde', true, 'Aviso con botón Reintentar');
    await failing.close();
    server = await startServer();
  } finally {
    await browser.close();
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
  const failed = results.filter((result) => !result.ok);
  writeFileSync(
    join(evidence, 'browser-check.json'),
    `${JSON.stringify({ at: new Date().toISOString(), browser: 'Edge/Chrome headless (playwright-core, perfil temporal)', results }, null, 2)}\n`,
  );
  process.stdout.write(`\n${String(results.length - failed.length)}/${String(results.length)} verificaciones de navegador correctas.\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
