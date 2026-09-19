# Build from the repository root:  docker build -f worker/Dockerfile .
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY shared ./shared
COPY functions ./functions
COPY worker ./worker
RUN npm ci --workspaces --include-workspace-root=false --ignore-scripts
RUN npm --workspace worker run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY worker/package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY --from=build /repo/worker/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
