FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm ci \
  && npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force \
  && rm -rf /root/.npm

FROM node:22-bookworm-slim AS runtime

WORKDIR /src
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY hook-forwarder.cjs ./hook-forwarder.cjs
COPY test-workspace ./test-workspace
COPY downstream-project ./downstream-project

RUN rm -rf /root/.npm /tmp/* \
  && find /src/node_modules/@anthropic-ai -maxdepth 1 -type d -name 'claude-code-linux-*' -exec rm -rf {} +

EXPOSE 8080

CMD ["npm", "start"]
