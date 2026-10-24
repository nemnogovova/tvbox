# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/backend ./apps/backend
COPY apps/remote-client ./apps/remote-client

RUN npm ci --no-audit --no-fund -w @tvbox/shared -w @tvbox/backend -w @tvbox/remote-client
RUN npm run build -w @tvbox/shared
RUN npm run build -w @tvbox/backend
RUN npm run build -w @tvbox/remote-client

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=512

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/remote-client/package.json ./apps/remote-client/package.json

RUN npm ci --omit=dev --no-audit --no-fund -w @tvbox/shared -w @tvbox/backend -w @tvbox/remote-client

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/remote-client/dist ./apps/remote-client/dist

WORKDIR /app/apps/backend
ENV STATIC_DIR=/app/apps/remote-client/dist
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "dist/index.js"]
