#!/usr/bin/env node
/**
 * MCP Database Server — Dual-Mode Entry Point
 *
 * Supports two transport modes:
 * - stdio (default): For use as a subprocess spawned by an MCP client
 * - http: For use as a standalone HTTP server (on-premise relay)
 *
 * Tools:
 * - db_list_tables: List tables/views the user has allowed access to
 * - db_describe_table: Get schema + sample rows for a specific table
 * - db_query: Execute read-only SQL queries
 *
 * Transport mode selected via MCP_TRANSPORT env var ('stdio' | 'http').
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, SERVER_NAME, SERVER_VERSION } from './config.js';
import { createDriver } from './driver-factory.js';
import { createMcpServer } from './server.js';

async function main() {
  const mode = process.env.MCP_TRANSPORT ?? 'stdio';

  if (mode === 'http') {
    // HTTP mode — load config from file, start HTTP server
    const configPath = process.env.CONFIG_PATH ?? './db-mcp-server.yaml';
    const { loadConfigFromFile } = await import('./config-file.js');
    const { createHttpServer } = await import('./http-server.js');

    const fileConfig = await loadConfigFromFile(configPath);
    const serverConfig = { credentials: fileConfig.credentials, config: fileConfig.dbConfig };
    const driver = createDriver(serverConfig.credentials);
    const mcpServer = createMcpServer(driver, serverConfig);

    const { server: httpServer, transport } = createHttpServer({
      port: fileConfig.server.port,
      apiKey: fileConfig.server.api_key,
    });

    mcpServer.connect(transport);

    const port = fileConfig.server.port;
    httpServer.listen(port, () => {
      console.error(`MCP ${SERVER_NAME} server v${SERVER_VERSION} started (HTTP mode, port ${port})`);
    });

    process.on('SIGTERM', async () => {
      console.error('[database] SIGTERM received, closing...');
      await driver.close();
      httpServer.close();
      process.exit(0);
    });
  } else {
    // Stdio mode (default) — for use as a subprocess
    const serverConfig = await loadConfig();
    const driver = createDriver(serverConfig.credentials);
    const mcpServer = createMcpServer(driver, serverConfig);

    const transport = new StdioServerTransport();
    mcpServer.connect(transport);

    process.on('SIGTERM', async () => {
      console.error('[database] SIGTERM received, closing driver...');
      await driver.close();
      process.exit(0);
    });

    console.error(`MCP ${SERVER_NAME} server v${SERVER_VERSION} started`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
