# syntax=docker/dockerfile:1

# ---------- 1) Dependencias ----------
# Aquí hay compilador por si better-sqlite3 (módulo nativo) no trae binario ya hecho para el sistema del servidor.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- 2) Imagen final (sin compiladores) ----------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/ascensor.db
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
# preguntas.json y empleados.json: de ahí se carga la base la primera vez (la base en sí vive en el volumen /data)
COPY data ./data
# utilidades que se pueden correr dentro del contenedor (docker compose exec ascensor node scripts/...)
COPY scripts/seed-preguntas.js scripts/limpiar-historial.js ./scripts/

# La base de datos (preguntas, ranking e historial) vive en /data, que es un volumen: sobrevive a reinicios y actualizaciones
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
