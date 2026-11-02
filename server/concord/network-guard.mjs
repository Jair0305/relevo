// @ts-check
/**
 * Precarga (`node --import`) que corre dentro de cada proceso de Concord que
 * lanza Relevo. Concord 0.19.0 solo habla con la red mediante `fetch`
 * (telemetría, comprobación de versiones, nube) y `WebSocket`/`node:net`
 * (adaptadores de Codex/Copilot y entrega en vivo). La demo no necesita
 * ninguno: la telemetría y la comprobación de versiones ya van desactivadas
 * por variables de entorno, y esto es una segunda barrera.
 *
 * Cualquier intento queda bloqueado y se anuncia en stderr con la marca
 * RELEVO_NETWORK_BLOCKED, que el orquestador captura y muestra como evidencia.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const MARK = 'RELEVO_NETWORK_BLOCKED';

/** @param {string} kind @param {unknown} target */
function blocked(kind, target) {
  const text = typeof target === 'string' ? target : target instanceof URL ? target.href : '';
  process.stderr.write(`${MARK} ${kind} ${text.slice(0, 120)}\n`);
  return new Error(`Relevo bloqueó un acceso de red (${kind}).`);
}

const originalFetch = globalThis.fetch;
// Las URL `data:` no salen de la máquina: el CLI de Concord carga así un
// módulo WASM embebido (yoga, del motor de terminal). Todo lo demás se bloquea.
globalThis.fetch = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit | undefined} */ init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('data:')) return originalFetch(input, init);
  throw blocked('fetch', url);
};

class BlockedWebSocket {
  /** @param {string | URL} url */
  constructor(url) {
    throw blocked('websocket', url);
  }
}
Object.defineProperty(globalThis, 'WebSocket', { value: BlockedWebSocket, configurable: true });

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');

/** @param {string} kind */
function refuse(kind) {
  return (/** @type {unknown[]} */ ...args) => {
    throw blocked(kind, args[0]);
  };
}

net.connect = refuse('net.connect');
net.createConnection = refuse('net.createConnection');
tls.connect = refuse('tls.connect');
http.request = refuse('http.request');
http.get = refuse('http.get');
https.request = refuse('https.request');
https.get = refuse('https.get');
syncBuiltinESMExports();
