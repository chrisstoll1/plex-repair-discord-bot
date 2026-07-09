FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY frontend/package*.json ./frontend/
RUN npm --prefix frontend ci
COPY tsconfig.json ./
COPY src ./src
COPY frontend ./frontend
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3000

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

VOLUME ["/config"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 CMD curl --fail --silent --output /dev/null "http://127.0.0.1:${HTTP_PORT:-3000}/health" || exit 1
CMD ["node", "dist/main.js"]
