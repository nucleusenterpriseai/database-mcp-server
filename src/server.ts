/**
 * MCP Server Factory
 *
 * Creates and configures the MCP server with all 3 database tools.
 * Shared by both stdio and HTTP transport modes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SERVER_NAME, SERVER_VERSION, MAX_SAMPLE_ROWS } from './config.js';
import { handleDbListTables } from './tools/db_list_tables.js';
import { handleDbDescribeTable } from './tools/db_describe_table.js';
import { handleDbQuery } from './tools/db_query.js';
import type { DatabaseDriver, ServerConfig } from './types.js';

/**
 * Create an MCP server with all database tools registered.
 */
export function createMcpServer(driver: DatabaseDriver, serverConfig: ServerConfig): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ─── Tool: db_list_tables ───────────────────────────────────────────
  server.tool(
    'db_list_tables',
    'List all tables and views the user has allowed access to. Returns table names, types (table/view), schemas, and approximate row counts. Use this first to discover what data is available before querying.',
    {
      schema: z
        .string()
        .optional()
        .describe('Filter by schema name (optional, default: all allowed schemas)'),
    },
    async (args) => {
      try {
        const tables = await handleDbListTables(driver, serverConfig, args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(tables, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Tool: db_describe_table ────────────────────────────────────────
  server.tool(
    'db_describe_table',
    "Get detailed schema for a specific table: column names, types, nullable, defaults, constraints, plus sample rows. Use this to understand a table's structure before writing queries.",
    {
      table: z.string().describe("Table name (e.g., 'public.orders' or 'orders')"),
      sample_rows: z
        .number()
        .optional()
        .describe(`Number of sample rows to return (default: 3, max: ${MAX_SAMPLE_ROWS})`),
    },
    async (args) => {
      try {
        const description = await handleDbDescribeTable(driver, serverConfig, args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(description, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Tool: db_query ─────────────────────────────────────────────────
  server.tool(
    'db_query',
    'Execute a read-only SQL query against the connected database. Only SELECT queries are allowed. Results are limited to 1000 rows. The query is automatically rewritten to apply column masking and row filters configured by the user.',
    {
      sql: z.string().describe('SQL SELECT query to execute'),
    },
    async (args) => {
      try {
        const result = await handleDbQuery(driver, serverConfig, args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
