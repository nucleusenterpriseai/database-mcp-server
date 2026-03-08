/**
 * db_describe_table Tool
 *
 * Returns detailed schema for a specific table: columns, types, constraints, sample rows.
 * Validates the table is in the allowed_tables list.
 */

import type { DatabaseDriver, ServerConfig, TableDescription } from '../types.js';
import { DEFAULT_SAMPLE_ROWS, MAX_SAMPLE_ROWS } from '../config.js';

interface DbDescribeTableInput {
  table: string;
  sample_rows?: number;
}

/**
 * Parse a table reference into schema and table name.
 * "public.orders" → { schema: "public", table: "orders" }
 * "orders" → { schema: "public", table: "orders" }
 */
function parseTableRef(tableRef: string): { schema: string; table: string } {
  const parts = tableRef.split('.');
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  return { schema: 'public', table: parts[0] };
}

/**
 * Check if a table reference is in the allowed_tables list.
 */
function isTableAllowed(tableRef: string, allowedTables: string[]): boolean {
  const { schema, table } = parseTableRef(tableRef);
  const fullName = `${schema}.${table}`;
  return allowedTables.some(
    (allowed) => allowed === fullName || allowed === table,
  );
}

/**
 * Handle db_describe_table tool call.
 */
export async function handleDbDescribeTable(
  driver: DatabaseDriver,
  serverConfig: ServerConfig,
  input: DbDescribeTableInput,
): Promise<TableDescription> {
  if (serverConfig.config.allowed_tables.length > 0 && !isTableAllowed(input.table, serverConfig.config.allowed_tables)) {
    throw new Error(
      `Table '${input.table}' is not in the allowed tables list. Use db_list_tables to see available tables.`,
    );
  }

  const { schema, table } = parseTableRef(input.table);
  const sampleRows = Math.min(
    input.sample_rows ?? DEFAULT_SAMPLE_ROWS,
    MAX_SAMPLE_ROWS,
  );

  return driver.describeTable(schema, table, sampleRows);
}
