# Relevo — imagen para servidor propio. No publica nada por sí misma.
# Fija también el digest de la imagen base cuando la construyas en tu servidor:
#   docker pull node:22-bookworm-slim && docker inspect --format '{{index .RepoDigests 0}}' node:22-bookworm-slim
FROM node:22-bookworm-slim

# git: cada corrida crea repos sintéticos locales (sin remoto).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Dependencias fijadas por package-lock y sin scripts de instalación.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY web ./web
COPY captures ./captures

RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV NODE_ENV=production \
    RELEVO_HOST=0.0.0.0 \
    RELEVO_ALLOW_REMOTE=1 \
    RELEVO_PORT=4317 \
    RELEVO_DATA_DIR=/app/data

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/main.ts"]
