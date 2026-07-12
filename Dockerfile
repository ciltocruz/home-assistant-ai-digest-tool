FROM node:22-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY backend backend
COPY frontend frontend
COPY packages packages
RUN pnpm run build

FROM node:22-slim AS runtime-preview

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    FRONTEND_DIST_DIR=/app/frontend-dist

RUN groupadd --gid 1001 app && useradd --uid 1001 --gid app --home-dir /app --create-home app
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/frontend/dist ./frontend-dist
RUN mkdir -p /data && chown -R app:app /app /data

EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/ready').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"
USER app
CMD ["node", "backend/dist/server.js"]
