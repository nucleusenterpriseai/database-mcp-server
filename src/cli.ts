#!/usr/bin/env node
/**
 * CLI Entry Point for DB MCP Server
 *
 * Commands:
 *   start [--config path]    Start HTTP server (single or multi-database)
 *   generate-key             Generate a new API key
 *   --version                Print version
 *   --help                   Print usage
 */

import { generateApiKey } from './auth.js';
import { SERVER_VERSION } from './config.js';

const args = process.argv.slice(2);
const command = args[0];

function getConfigPath(defaultPath = './db-mcp-server.yaml'): string {
  const idx = args.indexOf('--config');
  if (idx === -1) return defaultPath;
  const value = args[idx + 1];
  if (!value || value.startsWith('-')) {
    console.error('Error: --config requires a file path argument');
    process.exit(1);
  }
  return value;
}

function printHelp() {
  console.log(`db-mcp-server v${SERVER_VERSION}

Usage:
  db-mcp-server start [--config <path>]   Start HTTP server (default: ./db-mcp-server.yaml)
  db-mcp-server init [--yes] [--config <path>]  Set up database connection interactively
  db-mcp-server generate-key              Generate a new API key
  db-mcp-server test-connection [--config] Test database connectivity
  db-mcp-server --version                 Print version
  db-mcp-server --help                    Print this help message

Config formats:
  Single database:  server + database + security sections
  Multi-database:   server + databases[] array (one HTTP server per entry)`);
}

async function startServer() {
  const configPath = getConfigPath();

  const { loadAllDatabaseConfigs } = await import('./config-file.js');
  const { createHttpServer, createTlsHttpServer } = await import('./http-server.js');
  const { createMcpServer } = await import('./server.js');
  const { createDriver } = await import('./driver-factory.js');

  const dbConfigs = await loadAllDatabaseConfigs(configPath);

  const instances: Array<{
    name: string;
    server: import('node:http').Server | import('node:https').Server;
    driver: import('./types.js').DatabaseDriver;
  }> = [];

  try {
    for (const dbConfig of dbConfigs) {
      const serverConfig = { credentials: dbConfig.credentials, config: dbConfig.dbConfig };
      const driver = createDriver(serverConfig.credentials);

      const serverOpts = {
        port: dbConfig.port,
        apiKey: dbConfig.apiKey,
        createMcpServer: () => createMcpServer(driver, serverConfig),
      };

      let result;
      if (dbConfig.tls) {
        result = createTlsHttpServer({ ...serverOpts, tls: dbConfig.tls });
      } else {
        result = createHttpServer(serverOpts);
      }

      const protocol = dbConfig.tls ? 'https' : 'http';
      result.server.listen(dbConfig.port, () => {
        console.error(
          `MCP DB Server v${SERVER_VERSION} [${dbConfig.name}] listening on ${protocol}://0.0.0.0:${dbConfig.port}`,
        );
      });

      instances.push({ name: dbConfig.name, server: result.server, driver });
    }
  } catch (err) {
    // Clean up any instances created before the failure
    for (const { server, driver } of instances) {
      server.close();
      await driver.close();
    }
    throw err;
  }

  // Graceful shutdown — close all instances
  const shutdown = async () => {
    console.error('[database] Shutting down...');
    for (const { name, server, driver } of instances) {
      server.close();
      await driver.close();
      console.error(`[${name}] closed`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function testConnection() {
  const configPath = getConfigPath();

  const { loadAllDatabaseConfigs } = await import('./config-file.js');
  const { createDriver } = await import('./driver-factory.js');

  const dbConfigs = await loadAllDatabaseConfigs(configPath);

  for (const dbConfig of dbConfigs) {
    const driver = createDriver(dbConfig.credentials);
    try {
      await driver.ping();
      console.log(`[${dbConfig.name}] Connection OK (${dbConfig.credentials.db_type} @ ${dbConfig.credentials.host}:${dbConfig.credentials.port})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${dbConfig.name}] Connection FAILED: ${msg}`);
      process.exitCode = 1;
    } finally {
      await driver.close();
    }
  }
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
} else if (command === 'init') {
  const flags = {
    yes: args.includes('--yes') || args.includes('-y'),
    config: args.includes('--config') ? getConfigPath() : undefined,
  };
  import('./init.js').then(({ runInit }) =>
    runInit(flags),
  ).catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
} else if (command === 'test-connection') {
  testConnection().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
} else {
  printHelp();
  if (command && command !== '--help' && command !== '-h') {
    process.exit(1);
  }
}
