/**
 * db_describe_table Tool
 *
 * Returns detailed schema for a specific table: columns, types, constraints, sample rows.
 * Validates the table is in the allowed_tables list.
 */

import type { DatabaseDriver, ServerConfig, TableDescription } from '../types.js';
import { DEFAULT_SAMPLE_ROWS, MAX_SAMPLE_ROWS } from '../config.js';
import { maskValue } from '../json_masking.js';
import { applyJsonMasking } from '../json_masking.js';

interface DbDescribeTableInput {
  table: string;
  sample_rows?: number;
}

/**
 * Parse a table reference into schema and table name.
 * "public.orders" → { schema: "public", table: "orders" }
 * "orders" → { schema: defaultSchema, table: "orders" }
 *
 * Default schema is "public" for PostgreSQL, the database name for MySQL/ClickHouse.
 */
function parseTableRef(tableRef: string, defaultSchema = 'public'): { schema: string; table: string } {
  const parts = tableRef.split('.');
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  return { schema: defaultSchema, table: parts[0] };
}

/**
 * Get the default schema for a database type.
 * PostgreSQL uses "public", MySQL/ClickHouse use the database name.
 */
function getDefaultSchema(serverConfig: ServerConfig): string {
  const dbType = serverConfig.config.db_type;
  if (dbType === 'postgres' || dbType === 'postgresql') {
    return 'public';
  }
  return serverConfig.credentials.database;
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

  const defaultSchema = getDefaultSchema(serverConfig);
  const { schema, table } = parseTableRef(input.table, defaultSchema);
  const sampleRows = Math.min(
    input.sample_rows ?? DEFAULT_SAMPLE_ROWS,
    MAX_SAMPLE_ROWS,
  );

  const description = await driver.describeTable(schema, table, sampleRows);

  // Apply masking to sample rows
  if (description.sample_rows.length > 0) {
    // Column masking — apply maskValue to each masked column
    const { masking_rules } = serverConfig.config;
    if (masking_rules.length > 0) {
      const tableRules = masking_rules.filter(
        (r) => r.table.toLowerCase() === table.toLowerCase(),
      );
      if (tableRules.length > 0) {
        for (const row of description.sample_rows) {
          for (const rule of tableRules) {
            if (rule.type === 'none') continue;
            const key = Object.keys(row).find(
              (k) => k.toLowerCase() === rule.column.toLowerCase(),
            );
            if (key && row[key] != null) {
              row[key] = maskValue(row[key], rule.type);
            }
          }
        }
      }
    }

    // JSON-path masking
    const jsonRules = serverConfig.config.json_path_masking_rules ?? [];
    if (jsonRules.length > 0) {
      description.sample_rows = applyJsonMasking(
        description.sample_rows,
        table,
        jsonRules,
      );
    }
  }

  return description;
}
