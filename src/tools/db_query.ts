/**
 * db_query Tool
 *
 * Executes read-only SQL queries against the connected database.
 * All queries go through the integrated QueryRewriter pipeline:
 * classify → validate allowed tables → apply masking → inject row filters → enforce LIMIT.
 */

import type { DatabaseDriver, ServerConfig, QueryResult } from '../types.js';
import { MAX_ROWS } from '../config.js';
import { QueryRewriter } from '../rewriter.js';

interface DbQueryInput {
  sql: string;
}

/**
 * Handle db_query tool call.
 * Routes ALL queries through the QueryRewriter pipeline.
 */
export async function handleDbQuery(
  driver: DatabaseDriver,
  serverConfig: ServerConfig,
  input: DbQueryInput,
): Promise<QueryResult> {
  const { config } = serverConfig;

  const rewriter = new QueryRewriter(
    config.db_type,
    config.masking_rules,
    config.row_filters,
    config.allowed_tables,
    config.schema_cache || { tables: {} },
    MAX_ROWS,
  );

  const result = rewriter.rewrite(input.sql);
  if ('error' in result) {
    throw new Error(result.error);
  }

  return driver.query(result.rewritten);
}
