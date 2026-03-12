/**
 * db_query Tool
 *
 * Executes read-only SQL queries against the connected database.
 * All queries go through the integrated QueryRewriter pipeline:
 * classify → validate allowed tables → apply masking → inject row filters → enforce LIMIT.
 * After execution, JSON-path masking is applied to result rows.
 */

import type { DatabaseDriver, ServerConfig, QueryResult } from '../types.js';
import { MAX_ROWS } from '../config.js';
import { QueryRewriter } from '../rewriter.js';
import { applyJsonMasking } from '../json_masking.js';

interface DbQueryInput {
  sql: string;
}

/**
 * Extract table name from a SQL query for JSON-path masking lookup.
 * Returns the first FROM table reference (case-insensitive).
 */
function extractTableName(sql: string): string | null {
  const match = sql.match(/\bFROM\s+[`"']?(\w+)[`"']?/i);
  return match ? match[1] : null;
}

/**
 * Handle db_query tool call.
 * Routes ALL queries through the QueryRewriter pipeline,
 * then applies post-query JSON-path masking on result rows.
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

  const queryResult = await driver.query(result.rewritten);

  // Apply JSON-path masking to result rows (post-query, in-memory)
  const jsonRules = config.json_path_masking_rules ?? [];
  if (jsonRules.length > 0 && queryResult.rows.length > 0) {
    const tableName = extractTableName(result.rewritten);
    if (tableName) {
      queryResult.rows = applyJsonMasking(
        queryResult.rows,
        tableName,
        jsonRules,
      );
    }
  }

  return queryResult;
}
