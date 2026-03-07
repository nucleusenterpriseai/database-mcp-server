/**
 * SQL Safety — Query Classification & LIMIT Enforcement
 *
 * Classifies SQL statements as safe/write/destructive/blocked.
 * Enforces row LIMIT on SELECT queries.
 */

import { Parser } from 'node-sql-parser';
import { mapDialect } from './dialect.js';

export type QuerySafety = 'safe' | 'write' | 'destructive' | { blocked: string };

const WRITE_TYPES = new Set(['insert', 'update', 'delete', 'replace']);
const DESTRUCTIVE_TYPES = new Set(['drop', 'alter', 'truncate', 'create']);
const SESSION_TYPES = new Set(['set', 'commit', 'rollback', 'transaction']);
const SAFE_TYPES = new Set(['select', 'show', 'desc', 'describe', 'explain']);

const DANGEROUS_FUNCTIONS = new Set([
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export', 'pg_execute_server_program',
  'dblink', 'dblink_exec',
]);

/**
 * Recursively extract function names from an AST node.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFunctionNames(node: any): string[] {
  const names: string[] = [];
  if (!node || typeof node !== 'object') return names;

  if (node.type === 'function' && node.name?.name) {
    const nameArr = node.name.name;
    if (Array.isArray(nameArr)) {
      for (const part of nameArr) {
        if (part.value) names.push(part.value.toLowerCase());
      }
    } else if (typeof nameArr === 'string') {
      names.push(nameArr.toLowerCase());
    }
  }

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        names.push(...extractFunctionNames(item));
      }
    } else if (val && typeof val === 'object') {
      names.push(...extractFunctionNames(val));
    }
  }

  return names;
}

// Statements that are safe even if they fail to parse (parser doesn't support them)
const SAFE_PREFIXES = ['explain', 'show', 'describe', 'desc'];

/**
 * Classify a SQL query as safe, write, destructive, or blocked.
 */
export function classifyQuery(sql: string, dialect: string): QuerySafety {
  if (!sql || !sql.trim()) {
    return { blocked: 'empty query' };
  }

  // Pre-parse check: some safe statements (EXPLAIN, SHOW) fail to parse in certain dialects
  const firstWord = sql.trim().split(/\s/)[0].toLowerCase();
  if (SAFE_PREFIXES.includes(firstWord)) {
    return 'safe';
  }

  const parser = new Parser();
  const dbDialect = mapDialect(dialect);

  let ast;
  try {
    ast = parser.astify(sql, { database: dbDialect });
  } catch {
    return { blocked: 'parse error' };
  }

  if (Array.isArray(ast)) {
    return { blocked: 'multi-statement' };
  }

  const stmtType = (ast.type ?? '').toLowerCase();

  if (SESSION_TYPES.has(stmtType)) {
    return { blocked: 'session manipulation' };
  }

  if (WRITE_TYPES.has(stmtType)) return 'write';
  if (DESTRUCTIVE_TYPES.has(stmtType)) return 'destructive';

  if (!SAFE_TYPES.has(stmtType)) {
    return { blocked: `unsupported statement: ${stmtType}` };
  }

  // Check dangerous functions in SELECT
  if (stmtType === 'select') {
    const funcNames = extractFunctionNames(ast);
    for (const name of funcNames) {
      if (DANGEROUS_FUNCTIONS.has(name)) {
        return { blocked: `dangerous function: ${name}` };
      }
    }
  }

  return 'safe';
}

/**
 * Enforce LIMIT on SELECT queries. Non-SELECT returns unchanged.
 */
export function enforceLimit(sql: string, dialect: string, maxRows: number): string {
  const parser = new Parser();
  const dbDialect = mapDialect(dialect);

  let ast;
  try {
    ast = parser.astify(sql, { database: dbDialect });
  } catch {
    return sql;
  }

  if (Array.isArray(ast)) return sql;

  const stmtType = (ast.type ?? '').toLowerCase();
  if (stmtType !== 'select') return sql;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectAst = ast as any;
  const limitValues = selectAst.limit?.value;

  if (!Array.isArray(limitValues) || limitValues.length === 0) {
    selectAst.limit = {
      seperator: '',
      value: [{ type: 'number', value: maxRows }],
    };
  } else {
    const limitVal = limitValues[limitValues.length - 1];
    if (limitVal && typeof limitVal.value === 'number' && limitVal.value > maxRows) {
      limitVal.value = maxRows;
    }
  }

  return parser.sqlify(selectAst, { database: dbDialect });
}
