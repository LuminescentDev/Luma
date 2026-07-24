FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/collaboration-protocol/package.json packages/collaboration-protocol/package.json
COPY packages/collaboration-encryption/package.json packages/collaboration-encryption/package.json
COPY services/collaboration-server/package.json services/collaboration-server/package.json
RUN pnpm install --frozen-lockfile --filter @luma/collaboration-server...
COPY packages/collaboration-protocol packages/collaboration-protocol
COPY packages/collaboration-encryption packages/collaboration-encryption
COPY services/collaboration-server services/collaboration-server
RUN pnpm --filter @luma/collaboration-server... build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/collaboration-server/package.json services/collaboration-server/package.json
COPY --from=build /app/services/collaboration-server/node_modules services/collaboration-server/node_modules
COPY --from=build /app/services/collaboration-server/dist services/collaboration-server/dist
COPY --from=build /app/packages/collaboration-protocol packages/collaboration-protocol
COPY --from=build /app/packages/collaboration-encryption packages/collaboration-encryption
USER node
CMD ["node", "services/collaboration-server/dist/server.js"]
