FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run check && npm test && npm run build

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM dependencies AS runtime
COPY --from=builder /app/dist ./dist
COPY public ./public
USER node
CMD ["node","dist/app.js"]

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS browser-os
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox x11vnc websockify novnc supervisor fonts-noto-cjk fonts-liberation ca-certificates curl && rm -rf /var/lib/apt/lists/*

FROM browser-os AS browser
ENV NODE_ENV=production DISPLAY=:99 CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY deploy/supervisord.conf /etc/role-supervisord.conf
COPY --chmod=0755 deploy/start-browser.sh /app/start-browser.sh
COPY --chmod=0755 deploy/open-manual-browser.sh /app/open-manual-browser.sh
USER node
CMD ["supervisord","-n","-c","/etc/role-supervisord.conf"]
