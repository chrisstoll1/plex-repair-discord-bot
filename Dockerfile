FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3000

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

VOLUME ["/config"]
EXPOSE 3000
CMD ["node", "dist/main.js"]
