#!/usr/bin/env node
/**
 * CLI Entry Point for DB MCP Server
 *
 * Commands:
 *   start [--config path]    Start HTTP server
 *   generate-key             Generate a new API key
 *   --version                Print version
 *   --help                   Print usage
 */

import { generateApiKey } from './auth.js';
import { SERVER_VERSION } from './config.js';

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`db-mcp-server v${SERVER_VERSION}

Usage:
  db-mcp-server start [--config <path>]   Start HTTP server (default: ./db-mcp-server.yaml)
  db-mcp-server generate-key              Generate a new API key
  db-mcp-server test-connection [--config] Test database connectivity
  db-mcp-server --version                 Print version
  db-mcp-server --help                    Print this help message`);
}

async function startServer() {
  const configPath = args.includes('--config')
    ? args[args.indexOf('--config') + 1]
    : './db-mcp-server.yaml';

  const { loadConfigFromFile } = await import('./config-file.js');
  const { createHttpServer, createTlsHttpServer } = await import('./http-server.js');
  const { createMcpServer } = await import('./server.js');
  const { createDriver } = await import('./driver-factory.js');

  const fileConfig = await loadConfigFromFile(configPath);
  const serverConfig = { credentials: fileConfig.credentials, config: fileConfig.dbConfig };
  const driver = createDriver(serverConfig.credentials);
  const mcpServer = createMcpServer(driver, serverConfig);

  const port = fileConfig.server.port;
  const serverOpts = { port, apiKey: fileConfig.server.api_key };

  let result;
  if (fileConfig.server.tls) {
    result = createTlsHttpServer({ ...serverOpts, tls: fileConfig.server.tls });
  } else {
    result = createHttpServer(serverOpts);
  }

  mcpServer.connect(result.transport);

  const protocol = fileConfig.server.tls ? 'https' : 'http';
  result.server.listen(port, () => {
    console.error(`MCP DB Server v${SERVER_VERSION} listening on ${protocol}://0.0.0.0:${port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error('[database] Shutting down...');
    result.server.close();
    await driver.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (command === '--help' || command === '-h') {
  printHelp();
} else if (command === '--version' || command === '-v') {
  console.log(SERVER_VERSION);
} else if (command === 'generate-key') {
  console.log(generateApiKey());
} else if (command === 'start') {
  startServer().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
} else {
  printHelp();
  if (command && command !== '--help' && command !== '-h') {
    process.exit(1);
  }
}
