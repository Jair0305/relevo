# Revisión de Concord MCP antes de usarlo

**Qué se revisó:** `get-concord-ai/concord-mcp` en el commit
`82b51c38e69cbd7061d43fe42a4c73bac95e44cd` (versión 0.19.0, 30 oct 2026) y el
paquete npm `@concord-ai/concord-mcp@0.19.0`.
**Fecha:** 1 nov 2026. **Comandos y salidas:** [evidencias/auditoria-comandos.md](evidencias/auditoria-comandos.md).

## Resumen

No encontré nada que parezca malicioso: ni exfiltración, ni lectura de
credenciales ajenas, ni código descargado en tiempo de ejecución, ni scripts de
instalación. El paquete npm corresponde exactamente al código público:
recompilé desde el commit con el lockfile fijado y el `dist/` resultante es
idéntico byte a byte al publicado. Además, la atestación de procedencia del
registro apunta al mismo commit y al workflow de release de GitHub.

Sí hay **comportamientos con efectos fuera del repo** que conviene conocer y que
Relevo desactiva o aísla (ver tabla). Ninguno justificó no ejecutarlo, porque se
pueden aislar de forma razonable.

**Decisión:** ejecutar Concord **solo** dentro del sandbox de Relevo (entorno
limpio, HOME falso, modelo de permisos de Node, red bloqueada). **No** se usó
`npm i -g`, ni `concord setup`, ni el instalador `curl | sh`, ni se registró como
servidor MCP en ningún cliente (Claude Code, Codex, etc.).

## Alcance

| Revisado                                                        | Cómo                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Arranque del servidor MCP (`src/index.ts`) y del CLI            | Lectura completa                                                     |
| Telemetría, comprobación de versión, nube, autorreparación      | Lectura completa                                                     |
| Toda llamada a red, subproceso y escritura fuera del repo       | Búsqueda en `src/` y `plugin/`, lectura de cada resultado            |
| Las 5 herramientas MCP y su máquina de estados                  | Lectura + ejecución real (pruebas de Relevo)                         |
| `install.sh`, `package.json`, `pnpm-lock.yaml`, scripts         | Lectura                                                              |
| Correspondencia npm ↔ código                                    | Recompilación y `diff -r`; firma y atestación del registro           |
| Dependencias                                                    | Integridad del lockfile, scripts de ciclo de vida, `npm audit`       |

**No revisado:** el código de las ~150 dependencias transitivas (solo su
procedencia e integridad), los binarios nativos de `better-sqlite3`, los
adaptadores por arnés más allá de lo que se activa al arrancar, Concord Cloud y
su servidor, y el sitio getconcord.ai. Tampoco ejecuté la suite de pruebas del
propio Concord. Esta revisión **no es una garantía de seguridad**: es una lectura
dirigida a lo que podría hacer daño al instalarlo y ejecutarlo.

## Hallazgos

| #   | Hallazgo                                                                                                                                                                                                                                                                                                                                                   | Riesgo                                              | En Relevo                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | **Telemetría activa por defecto** hacia `https://getconcord.ai/api/telemetry/v2`. El código envía id de instalación aleatorio, versión, SO/arquitectura, nombres y resultados de operaciones, tiempos y un pseudónimo HMAC del workspace. No vi envío de código, rutas, mensajes ni contenido de tareas. El servidor guarda IP y país sin caducidad (según su README). | Privacidad, bajo                                    | Desactivada (`CONCORD_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`) y red bloqueada.    |
| 2   | **Comprobación diaria de versión** contra `registry.npmjs.org` y caché en `LOCALAPPDATA`/`~/.cache`.                                                                                                                                                                                                                                                       | Bajo                                                | Desactivada (`CONCORD_NO_UPDATE_CHECK=1`).                                         |
| 3   | **Autorreparación de adaptadores al arrancar.** Si el proceso MCP detecta que corre dentro de un arnés conocido (p. ej. `CLAUDE_CODE_SESSION_ID`), lanza en segundo plano `concord adapters ensure <arnés>`. Eso consulta la CLI del arnés y, si el usuario lo aceptó en `concord setup`, **instala plugins/hooks en su configuración global**.                 | Medio: cambia configuración global sin pedirlo en ese momento | No ocurre: identidad de operador con tipo `actor-demo`, sin variables de sesión, y sin permiso para procesos hijo. |
| 4   | **`concord setup` escribe mucho fuera del repo**: `~/.codex/config.toml`, y en modo global `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, etc. Lo documentan y dicen que se revierte.                                                                                                                                                      | Medio si se ejecuta sin leer                        | Nunca se ejecuta `setup`.                                                          |
| 5   | **Busca el repo hacia arriba.** Sin `.git` en la carpeta de trabajo, sube por los directorios y usa el primer repo que encuentre para crear `.concord/`. En esta máquina habría usado el repo RenderCV que contiene la app. Lo vi en la práctica: el sandbox lo bloqueó.                                                                                       | Medio en carpetas anidadas                          | Cada corrida crea su propio repo git; hay una prueba que lo cubre.                 |
| 6   | **La identidad no es una frontera de seguridad.** Si el proceso no conoce la sesión, acepta el `agent_id` que mande el cliente: un cliente puede actuar como otro agente. Con identidad de operador (`CONCORD_AGENT_ID`) sí la aplica: comprobé que un agente no puede leer la bandeja de otro ni responder mensajes ajenos.                                     | Bajo en local; relevante si se expone               | Cada actor tiene su propio proceso con `CONCORD_AGENT_ID`.                         |
| 7   | **Los choques son avisos, no candados.** `start_work` acepta un reclamo aunque choque; lo que frena la edición es `concord check` (código 1) y que el agente lo respete.                                                                                                                                                                                    | Expectativa, no seguridad                           | Se muestra en la demo como limitación verificada.                                  |
| 8   | **Instalador `curl … | sh`** (macOS/Linux): descarga de GitHub Releases y verifica sha256. Patrón cómodo pero confía en el canal de descarga.                                                                                                                                                                                                                | Bajo/medio (patrón)                                 | No se usó.                                                                         |
| 9   | El CLI hace `fetch` de una URL `data:` (WASM embebido del motor de terminal). No es red.                                                                                                                                                                                                                                                                   | Ninguno                                             | La guardia de red deja pasar solo `data:`.                                         |
| 10  | `react-devtools-core` es dependencia de producción (lo arrastra `ink` para el TUI). Solo actúa con `DEV=true` en el dashboard.                                                                                                                                                                                                                                | Bajo (superficie innecesaria)                       | No se usa el dashboard.                                                            |

Lo que no encontré: `eval`/`new Function`, `shell: true`, lecturas de `.ssh`,
`.aws`, `.npmrc`, cookies o tokens de otras herramientas, volcados de variables
de entorno, dependencias por git o tarballs externos, `preinstall`/`postinstall`.

## Cómo se aísla en Relevo

Cada proceso de Concord (servidor MCP o CLI) arranca con:

1. **Entorno desde cero**: solo `SystemRoot`, HOME/APPDATA/LOCALAPPDATA/TEMP
   apuntando a `data/runs/<id>/…/home`, `CONCORD_REPO_ROOT` y
   `CONCORD_ALLOWED_ROOTS` al workspace de la corrida, y las variables que
   apagan telemetría y actualizaciones. No hereda tokens ni ids de sesión.
2. **Modelo de permisos de Node** (`--permission`): lectura de `node_modules` y
   de la corrida, escritura solo en la corrida, sin procesos hijo ni workers;
   `--allow-addons` solo porque SQLite es nativo.
3. **Guardia de red** (`server/concord/network-guard.mjs`, precargada): bloquea
   `fetch`, `WebSocket`, `net`, `tls`, `http(s)` y lo anuncia en stderr. Cada
   corrida cuenta los intentos: hasta ahora, 0.
4. **Versión fijada**: `@concord-ai/concord-mcp@0.19.0` exacto en
   `package-lock.json`, instalado con `--ignore-scripts`.

Límites del aislamiento: el modelo de permisos de Node 22 no restringe la red
(por eso la guardia, que es una barrera dentro del proceso, no del sistema); un
código decidido a evadirla podría hacerlo. Para un aislamiento fuerte de red,
usa el contenedor de `compose.yaml` con una red sin salida (ver
[SERVIDOR_PROPIO.md](SERVIDOR_PROPIO.md)).

## Si alguien quiere usar Concord con agentes reales

Recomendaciones derivadas de esta revisión (no aplicadas en esta máquina):

- Exportar `CONCORD_TELEMETRY_DISABLED=1` antes del primer uso si no quieres telemetría.
- Leer qué escribe `concord setup` y preferir `--no-adapters` y `--no-global`
  hasta entenderlo; revisar `~/.concord/config.json` después.
- Ejecutarlo siempre en la raíz de un repo con `.git` propio, o fijar `CONCORD_REPO_ROOT`.
- Fijar la versión (`@0.19.0`) en lugar de `@latest`.
