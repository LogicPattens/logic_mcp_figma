FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
# Must run via `pnpm build`: tsup.config.ts reads npm_package_version,
# which is only set when invoked as a package script.
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
WORKDIR /app
# NODE_ENV must not be `cli` (forces stdio) or `development` (dumps raw Figma
# responses to logs/). Telemetry is PostHog in this build and on by default,
# so it is switched off here rather than relying on every deployer to do it.
ENV NODE_ENV=production \
    FRAMELINK_HOST=0.0.0.0 \
    FRAMELINK_PORT=3333 \
    FRAMELINK_TELEMETRY=off \
    SKIP_IMAGE_DOWNLOADS=true \
    OUTPUT_FORMAT=tree
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --header "Host: localhost" http://127.0.0.1:3333/healthz || exit 1
CMD ["node", "dist/bin.js"]
