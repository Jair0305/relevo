# Auditoría de Concord MCP: comandos y resultados (1 nov 2026)

Registro de lo que se ejecutó para revisar el repositorio y el paquete. Las
rutas locales se omiten. Nada de esto instaló software globalmente ni ejecutó
scripts del proyecto revisado.

## 1. Código fuente fijado

```text
git -c core.hooksPath=/dev/null clone --no-checkout https://github.com/get-concord-ai/concord-mcp.git
HEAD main      56cefcfb09eff8a0ddf9fbb69a7154d1c5ae8676  (Merge PR #305: 0.19.0)
commit 0.19.0  82b51c38e69cbd7061d43fe42a4c73bac95e44cd  (2026-10-30, Alex Choi)
git diff --stat 82b51c3 56cefcf   → sin diferencias (mismo árbol)
```

## 2. Paquete npm

```text
npm view @concord-ai/concord-mcp@0.19.0
  dist.shasum     9eaffc53eb8beeeef353298f794d0b18f59d1501
  dist.integrity  sha512-sUAdEl/hKqCTp/1t46GrSFemyJIGFakLFglMM6uCAFaXhZwpbD9D+hVuTprs5Y5jDO1oqBf/Lgi5kxKExPWm2g==
  gitHead         82b51c38e69cbd7061d43fe42a4c73bac95e44cd
  maintainers     alexechoi
  scripts         sin preinstall/install/postinstall (solo prepublishOnly: build)
npm pack @concord-ai/concord-mcp@0.19.0 --ignore-scripts
  sha256 del .tgz e22e37be13af1317ab2bcea845085d2713e88b2d7c8b2d9a344d23790300c94e
```

Atestación de procedencia (SLSA v1) del registro:

```text
workflow  .github/workflows/release.yml @ refs/tags/v0.19.0
commit    82b51c38e69cbd7061d43fe42a4c73bac95e44cd
npm audit signatures → 149 paquetes con firma de registro verificada, 22 con atestación verificada
npm audit            → 0 vulnerabilidades conocidas (a la fecha)
```

## 3. Compilación reproducible

```text
npx pnpm@10.33.0 install --frozen-lockfile --ignore-scripts --store-dir <local>
git checkout 82b51c3 && tsc -p tsconfig.build.json
diff -r dist <tarball>/package/dist        → idéntico (0 diferencias, 423 archivos)
diff -r plugin <tarball>/package/plugin    → idéntico
package.json (sin devDependencies)         → idéntico
```

## 4. Dependencias

```text
pnpm-lock.yaml: 310 resoluciones con integrity; ninguna dependencia por git ni tarball externo
Scripts de ciclo de vida en dependencias: ninguno preinstall/install/postinstall
  (solo "prepare", que npm/pnpm no ejecutan para paquetes del registro)
better-sqlite3 13.0.3 trae binarios precompilados (prebuilds/) para win32/linux/darwin:
  no descarga nada al instalar. Los binarios nativos no se auditaron.
Relevo instala Concord con npm ci --ignore-scripts (.npmrc: ignore-scripts=true)
  y comprueba que su dist/ instalado es idéntico al auditado (diff -r → idéntico).
```

## 5. Búsquedas en src/ y plugin/

```text
eval( / new Function(               → 0
shell: true                         → 0 (spawn siempre con shell:false)
.ssh, id_rsa, .aws, .npmrc, cookies,
tokens de terceros                  → 0
volcado de process.env              → 0
URLs de red en el código:
  https://getconcord.ai/api/telemetry/v2   telemetría (activa por defecto)
  https://registry.npmjs.org/...           comprobación diaria de versión
  https://api.getconcord.ai                solo con `concord cloud login`
  https://github.com/.../install.sh        solo para actualizar instalaciones standalone
```

## 6. Ejecución aislada (lo que hace Relevo cada vez)

- Entorno construido desde cero (lista blanca), HOME/APPDATA/LOCALAPPDATA falsos dentro de la corrida.
- `CONCORD_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `CONCORD_NO_UPDATE_CHECK=1`.
- `CONCORD_AGENT_KIND=actor-demo`: no coincide con ningún arnés, así que la autorreparación de adaptadores no corre.
- `node --permission`: lectura solo de `node_modules` y de la carpeta de la corrida; escritura solo en la corrida; sin procesos hijo ni workers.
- Precarga `network-guard.mjs`: bloquea `fetch` (excepto URLs `data:`), `WebSocket`, `net`, `tls`, `http(s)`.

Resultado en cada corrida: 0 intentos de red, 0 archivos de Concord en el HOME falso
(ver `captures/corrida-referencia.json` → `isolation`).

Hallazgo durante la ejecución: sin un `.git` propio en el workspace, Concord sube
por los directorios buscando un repositorio y habría usado el repo que contiene
la app. El modelo de permisos lo bloqueó (`Access to this API has been restricted`).
Relevo crea un repo git propio por corrida; la prueba
`el sandbox impide que Concord salga de la carpeta de la corrida` lo comprueba.
