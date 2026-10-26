# Runtime-only image: everything is pre-built on the developer machine
# (the 1 GB VPS must not run Vite/TypeScript builds).
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=512 \
    DATA_DIR=/data \
    STATIC_DIR=/app/public \
    PORT=3000
COPY server/package.json ./package.json
COPY server/shared ./shared
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/dist ./dist
COPY server/public ./public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
