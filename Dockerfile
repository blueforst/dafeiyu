FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY public ./public
COPY deploy/maintenance-helper.py ./deploy/maintenance-helper.py
COPY deploy/monitor.py ./deploy/monitor.py
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

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS camoufox-assets
ENV XDG_CACHE_HOME=/opt/role-camoufox/cache
WORKDIR /opt/role-camoufox
COPY browser-engines/camoufox/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && node_modules/.bin/camoufox fetch \
    && node --input-type=module -e "import { getModel } from './node_modules/camoufox/dist/fpgen/index.js'; getModel();" \
    && ln -s /tmp/role-camoufox-fontconfig cache/camoufox/fontconfig
COPY browser-engines/camoufox/launch.mjs ./launch.mjs

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS browser
ENV NODE_ENV=production DISPLAY=:99 XDG_CACHE_HOME=/opt/role-camoufox/cache
COPY --from=camoufox-assets /opt/role-camoufox /opt/role-camoufox
RUN apt-get update && apt-get install -y --no-install-recommends xvfb openbox x11vnc websockify novnc supervisor fonts-noto-cjk fonts-liberation ca-certificates curl \
    && /opt/role-camoufox/node_modules/.bin/playwright-core install-deps firefox \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY deploy/supervisord.conf /etc/role-supervisord.conf
COPY --chmod=0755 deploy/start-browser.sh /app/start-browser.sh
COPY --chmod=0755 deploy/open-manual-browser.sh /app/open-manual-browser.sh
USER node
CMD ["supervisord","-n","-c","/etc/role-supervisord.conf"]
