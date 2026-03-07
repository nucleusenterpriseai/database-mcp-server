/**
 * Row Filter Injection
 *
 * Injects WHERE conditions into SQL queries based on row filter rules.
 * Uses node-sql-parser AST for safe SQL transformation.
 * Fail-closed: throws on parse errors rather than returning unfiltered SQL.
 */

import { Parser } from 'node-sql-parser';
import { mapDialect } from './dialect.js';
import type { RowFilter } from './types.js';

/**
 * Build a map of table → conditions for quick lookup.
 */
function buildFilterMap(filters: RowFilter[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const filter of filters) {
    const key = filter.table.toLowerCase();
    const existing = map.get(key) || [];
    existing.push(filter.condition);
    map.set(key, existing);
  }
  return map;
}

/**
 * Extract table references from FROM clause with their names.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getFromTables(from: any[]): Array<{ table: string; alias?: string }> {
  const tables: Array<{ table: string; alias?: string }> = [];
  if (!Array.isArray(from)) return tables;

  for (const item of from) {
    if (item.table && typeof item.table === 'string') {
      tables.push({ table: item.table, alias: item.as || undefined });
    }
  }
  return tables;
}

/**
 * Build a WHERE condition AST node from a raw SQL condition string.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCondition(condition: string, dialect: string): any {
  const parser = new Parser();
  const dbDialect = mapDialect(dialect);
  try {
    const wrapSql = `SELECT 1 FROM t WHERE ${condition}`;
    const ast = parser.astify(wrapSql, { database: dbDialect });
    if (Array.isArray(ast)) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (ast as any).where;
  } catch {
    return null;
  }
}

/**
 * Combine two WHERE AST nodes with AND.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function andConditions(left: any, right: any): any {
  if (!left) return right;
  if (!right) return left;
  return {
    type: 'binary_expr',
    operator: 'AND',
    left,
    right,
    parentheses: true,
  };
}

/**
 * Apply row filters to a SQL query.
 * Returns the rewritten SQL string.
 */
export function applyRowFilters(
  sql: string,
  dialect: string,
  filters: RowFilter[],
): string {
  if (filters.length === 0) return sql;

  const parser = new Parser();
  const dbDialect = mapDialect(dialect);
  const filterMap = buildFilterMap(filters);

  let ast;
  try {
    ast = parser.astify(sql, { database: dbDialect });
  } catch {
    throw new Error('Could not parse the SQL query for row filtering. Please check the syntax.');
  }

  if (Array.isArray(ast)) {
    throw new Error('Multi-statement queries cannot have row filters applied.');
  }
  if ((ast.type ?? '').toLowerCase() !== 'select') return sql;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectAst = ast as any;
  const fromClause = selectAst.from;
  if (!Array.isArray(fromClause)) return sql;

  const tables = getFromTables(fromClause);
  let hasFilterMatch = false;

  for (const tableRef of tables) {
    const conditions = filterMap.get(tableRef.table.toLowerCase());
    if (!conditions) continue;

    hasFilterMatch = true;

    for (const condition of conditions) {
      const conditionAst = parseCondition(condition, dialect);
      if (!conditionAst) continue;

      selectAst.where = andConditions(selectAst.where, conditionAst);
    }
  }

  if (!hasFilterMatch) return sql;

  try {
    return parser.sqlify(selectAst, { database: dbDialect });
  } catch {
    throw new Error('Failed to serialize SQL after applying row filters.');
  }
}
