# Relevo en un servidor propio

Instrucciones preparadas, **no ejecutadas**. Nada de esto se ha desplegado ni se
ha construido la imagen; solo se validó la sintaxis con `docker compose config`.

## Qué necesita

| Recurso   | Valor                                                                                       |
| --------- | ------------------------------------------------------------------------------------------- |
| Puerto    | `4317/tcp` dentro del contenedor; Compose lo publica solo en `127.0.0.1:4317` del host       |
| Volumen   | `relevo-data` → `/app/data` (corridas guardadas; se borra desde la propia app)              |
| Memoria   | Una corrida arranca hasta 4 procesos Node a la vez (estimación, no medido en servidor). Límite en Compose: 512 MB |
| CPU       | Una corrida tarda ≈ 8–10 s en un portátil Windows. Límite en Compose: 1.0                    |
| Disco     | Cada corrida guardada ≈ 80 KB (se conservan las últimas 12); los repos de trabajo se borran al terminar |
| Salida a red | Ninguna en tiempo de ejecución                                                           |

Solo hay **una corrida a la vez** y un límite global por hora
(`RELEVO_MAX_RUNS_PER_HOUR`, 30 por defecto).

## Opción A: Docker Compose (Linux)

```bash
# en el servidor, dentro de la carpeta relevo/
docker compose build
docker compose up -d
curl -s http://127.0.0.1:4317/api/status
```

Para verlo desde tu equipo sin abrir puertos:

```bash
ssh -L 4317:127.0.0.1:4317 usuario@tu-servidor
# y abre http://localhost:4317
```

El `compose.yaml` ya trae: sistema de archivos de solo lectura (salvo el
volumen y `/tmp`), `cap_drop: ALL`, `no-new-privileges`, límites de memoria,
CPU y procesos, usuario sin privilegios (`node`).

### Sin salida a Internet (recomendado)

Relevo no necesita red saliente. Para cortarla a nivel de contenedor, añade al
servicio una red interna y publica el puerto mediante tu proxy en esa red, o
usa `network_mode: none` si solo lo vas a consultar con `docker exec`. Revisa
que esto no choque con tu configuración de Docker antes de aplicarlo.

## Opción B: Node directamente (Linux, sin Docker)

```bash
# Node 22.18+ y git
npm ci --ignore-scripts --omit=dev
RELEVO_PORT=4317 node server/main.ts
```

Para un servicio, un unit de systemd con `User=` dedicado,
`ProtectHome=yes`, `ProtectSystem=strict`, `ReadWritePaths=/ruta/relevo/data`,
`PrivateTmp=yes` y `NoNewPrivileges=yes` da un aislamiento parecido al del
contenedor.

## Si decides exponerlo a Internet

No viene preparado para eso por defecto y conviene pensarlo antes:

1. **Usa modo repetición**: `RELEVO_READONLY=1`. Así solo muestra corridas
   reales capturadas (`captures/`) y no ejecuta procesos por petición.
   Si quieres corridas en vivo públicas, pon autenticación delante.
2. **Proxy inverso con TLS** (Caddy, nginx, Traefik) apuntando a
   `127.0.0.1:4317`. No cambies el `ports:` a `0.0.0.0`.
3. **Cabecera Host**: añade tu dominio a `RELEVO_ALLOWED_HOSTS`
   (p. ej. `relevo.tu-dominio.com`). Cualquier otro Host recibe 421.
4. Mantén `RELEVO_MAX_RUNS_PER_HOUR` bajo si dejas corridas en vivo.

## Variables

| Variable                   | Por defecto  | Uso                                                       |
| -------------------------- | ------------ | --------------------------------------------------------- |
| `RELEVO_HOST`              | `127.0.0.1`  | Interfaz de escucha                                       |
| `RELEVO_PORT`              | `4317`       | Puerto                                                    |
| `RELEVO_ALLOW_REMOTE`      | —            | Debe ser `1` para escuchar fuera de loopback              |
| `RELEVO_ALLOWED_HOSTS`     | —            | Hosts extra aceptados (coma)                              |
| `RELEVO_READONLY`          | `0`          | `1` = solo repeticiones                                   |
| `RELEVO_MAX_RUNS_PER_HOUR` | `30`         | Límite global de corridas                                 |
| `RELEVO_DATA_DIR`          | `./data`     | Dónde se guardan corridas                                 |
| `RELEVO_KEEP_WORKSPACES`   | —            | `1` = no borrar los repos de cada corrida (depuración)    |

## Actualizar Concord

1. Revisar el diff del nuevo tag y repetir los pasos de
   [evidencias/auditoria-comandos.md](evidencias/auditoria-comandos.md).
2. `npm install @concord-ai/concord-mcp@<versión> --save-exact --ignore-scripts`.
3. `npm run verify` y `npm run capture` para regenerar la repetición.
