# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Adrialga · backend unificado (API + Socket.IO + web Flutter)
#
# El CONTEXTO de construcción es la RAÍZ del monorepo, porque la imagen necesita
# la build de Flutter y el subconjunto de imágenes de producto:
#
#   docker build -f adrialga-backend/Dockerfile -t adrialga-backend .
#
# Requisito previo (una vez por recorte de catálogo):
#   cd adrialga-backend && npm run imagenes:deploy
# ─────────────────────────────────────────────────────────────────────────────

# ── Etapa 1: compilación TypeScript ──────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Prisma necesita openssl para su motor de consultas.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY adrialga-backend/package.json adrialga-backend/package-lock.json ./

# --ignore-scripts evita que el `postinstall` (prisma generate) se ejecute ANTES
# de que prisma/schema.prisma esté copiado. Se genera explícitamente más abajo.
RUN npm ci --ignore-scripts

COPY adrialga-backend/prisma ./prisma
COPY adrialga-backend/tsconfig.json ./
COPY adrialga-backend/src ./src

# `npm run build` = prisma generate && tsc
RUN npm run build

# Quita dependencias de desarrollo conservando el cliente Prisma generado.
RUN npm prune --omit=dev

# ── Etapa 2: ejecución ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# curl se usa en el HEALTHCHECK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY adrialga-backend/prisma ./prisma
COPY adrialga-backend/package.json ./

# Build de Flutter Web (~44 MB). La sirve el propio backend: mismo origen, sin CORS.
COPY adrialga_frontend/build/web ./web

# Solo el subconjunto de imágenes que el sistema puede mostrar (91 archivos,
# 2,2 MB). El catálogo completo pesa 177 MB y no debe viajar en la imagen.
COPY adrialga-backend/public/productos_deploy ./public/productos_deploy

# Rutas configurables: sin ellas la resolución relativa al monorepo apunta fuera
# de la aplicación y ni la web ni las imágenes se sirven.
ENV WEB_ROOT=/app/web
ENV PRODUCTOS_DIR=/app/public/productos_deploy
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
