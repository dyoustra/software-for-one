FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
# The slim image has no CA bundle, and Litestream talks to Tigris over TLS.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tgz
RUN tar -C /usr/local/bin -xzf /tmp/litestream.tgz && rm /tmp/litestream.tgz
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json deploy/litestream.yml deploy/start.sh ./
ARG SFO_VERSION=dev
ENV SFO_VERSION=$SFO_VERSION NODE_ENV=production NODE_NO_WARNINGS=1
CMD ["./start.sh"]
