/**
 * db_list_tables Tool
 *
 * Lists tables and views the user has allowed access to.
 * Filters results against the allowed_tables configuration.
 */

import type { DatabaseDriver, ServerConfig, TableMeta } from '../types.js';

interface DbListTablesInput {
  schema?: string;
}

/**
 * Check if a table is in the allowed_tables list.
 * Supports both "schema.table" and "table" (no schema prefix) formats.
 */
function isTableAllowed(table: TableMeta, allowedTables: string[]): boolean {
  const fullName = `${table.schema}.${table.name}`;
  return allowedTables.some(
    (allowed) => allowed === fullName || allowed === table.name,
  );
}

/**
 * Extract distinct schemas from allowed_tables entries.
 * Entries without a schema prefix default to 'public'.
 */
function getDistinctSchemas(allowedTables: string[]): string[] {
  const schemas = new Set<string>();
  for (const entry of allowedTables) {
    const parts = entry.split('.');
    schemas.add(parts.length >= 2 ? parts[0] : 'public');
  }
  return [...schemas];
}

/**
 * Handle db_list_tables tool call.
 * Returns only tables that are in the allowed_tables configuration.
 * When no schema filter is provided, queries all schemas from allowed_tables.
 */
export async function handleDbListTables(
  driver: DatabaseDriver,
  serverConfig: ServerConfig,
  input: DbListTablesInput,
): Promise<TableMeta[]> {
  let allTables: TableMeta[];
  const allowedTables = serverConfig.config.allowed_tables;

  if (input.schema) {
    // User specified a schema — query only that schema
    allTables = await driver.listTables(input.schema);
  } else if (allowedTables.length === 0) {
    // No allowed_tables configured — query default schema (no restriction)
    allTables = await driver.listTables();
  } else {
    // No schema filter — query all distinct schemas from allowed_tables
    const schemas = getDistinctSchemas(allowedTables);
    const results = await Promise.all(
      schemas.map((s) => driver.listTables(s)),
    );
    allTables = results.flat();
  }

  // Skip filtering when allowed_tables is empty (no restriction)
  if (allowedTables.length === 0) {
    return allTables;
  }

  return allTables.filter((table) =>
    isTableAllowed(table, allowedTables),
  );
}
