# Stage 1: Build TypeScript
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production image
FROM node:18-alpine AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --production && npm cache clean --force
COPY --from=builder /app/dist/ ./dist/

# Non-root user for security
RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp

EXPOSE 8443
ENV MCP_TRANSPORT=http
ENV CONFIG_PATH=/app/config/db-mcp-server.yaml

ENTRYPOINT ["node", "dist/cli.js", "start"]
CMD ["--config", "/app/config/db-mcp-server.yaml"]
