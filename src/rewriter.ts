/**
 * Integrated Query Rewriting Pipeline
 *
 * Chains: classify → validate allowed tables → apply masking →
 * inject row filters → enforce LIMIT → serialize
 */

import { classifyQuery, enforceLimit } from './safety.js';
import { applyMasking } from './masking.js';
import { applyRowFilters } from './row_filter.js';
import type { MaskingRule, RowFilter, SchemaCache } from './types.js';
import { Parser } from 'node-sql-parser';
import { mapDialect } from './dialect.js';

const ERROR_MESSAGES: Record<string, string> = {
  write: 'Write operations (INSERT, UPDATE, DELETE) are not allowed. Only SELECT queries are permitted.',
  destructive: 'Destructive operations (DROP, ALTER, TRUNCATE) are not allowed.',
  'multi-statement': 'Multi-statement queries are not allowed. Please send one query at a time.',
  'session manipulation': 'Session manipulation (SET, COMMIT, ROLLBACK) is not allowed.',
  'empty query': 'Empty SQL query is not allowed. Please provide a valid SELECT query.',
  'parse error': 'Could not parse the SQL query. Please check the syntax and try again.',
};

/**
 * Extract all table references from a parsed AST.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTableReferences(node: any): string[] {
  const tables: string[] = [];
  if (!node || typeof node !== 'object') return tables;

  if (node.table && typeof node.table === 'string' && !node.type) {
    const schema = node.db || node.schema || '';
    tables.push(schema ? `${schema}.${node.table}` : node.table);
  }

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        tables.push(...extractTableReferences(item));
      }
    } else if (val && typeof val === 'object') {
      if (val.ast) {
        tables.push(...extractTableReferences(val.ast));
      }
      tables.push(...extractTableReferences(val));
    }
  }

  return [...new Set(tables)];
}

export class QueryRewriter {
  constructor(
    private dialect: string,
    private maskingRules: MaskingRule[],
    private rowFilters: RowFilter[],
    private allowedTables: string[],
    private schemaCache: SchemaCache,
    private maxRows: number = 1000,
  ) {}

  rewrite(sql: string): { rewritten: string } | { error: string } {
    // Step 1: Classify query safety
    const safety = classifyQuery(sql, this.dialect);

    if (safety === 'write') {
      return { error: ERROR_MESSAGES.write };
    }
    if (safety === 'destructive') {
      return { error: ERROR_MESSAGES.destructive };
    }
    if (typeof safety === 'object' && 'blocked' in safety) {
      const reason = safety.blocked;
      if (ERROR_MESSAGES[reason]) {
        return { error: ERROR_MESSAGES[reason] };
      }
      if (reason.startsWith('dangerous function')) {
        return { error: `Function '${reason.replace('dangerous function: ', '')}' is blocked. Dangerous functions are not allowed.` };
      }
      return { error: `Statement type '${reason.replace('unsupported statement: ', '')}' is not allowed. Only SELECT queries are permitted.` };
    }

    // Step 2: Validate allowed tables
    if (this.allowedTables.length > 0) {
      const tableError = this.validateAllowedTables(sql);
      if (tableError) {
        return { error: tableError };
      }
    }

    // Step 3: Apply column masking
    let rewritten = sql;
    if (this.maskingRules.length > 0) {
      rewritten = applyMasking(rewritten, this.dialect, this.maskingRules, this.schemaCache);
    }

    // Step 4: Inject row filters
    if (this.rowFilters.length > 0) {
      rewritten = applyRowFilters(rewritten, this.dialect, this.rowFilters);
    }

    // Step 5: Enforce LIMIT
    rewritten = enforceLimit(rewritten, this.dialect, this.maxRows);

    return { rewritten };
  }

  private validateAllowedTables(sql: string): string | null {
    const parser = new Parser();
    const dbDialect = mapDialect(this.dialect);

    let ast;
    try {
      ast = parser.astify(sql, { database: dbDialect });
    } catch {
      return null; // Parse errors caught by classify step
    }

    if (Array.isArray(ast)) return null;

    const tableRefs = extractTableReferences(ast);
    const allowedSet = new Set(this.allowedTables.map((t) => t.toLowerCase()));

    for (const ref of tableRefs) {
      if (!allowedSet.has(ref.toLowerCase())) {
        return `Table '${ref}' is not in the allowed tables list. Use db_list_tables to see available tables.`;
      }
    }

    return null;
  }
}
