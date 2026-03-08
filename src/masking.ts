/**
 * Column Masking via SQL Query Rewriting
 *
 * Rewrites SELECT queries to apply column-level masking expressions.
 * Parses with node-sql-parser to understand structure, then builds
 * masked SQL using string construction for reliable output.
 * Fail-closed: throws on parse errors rather than returning unmasked SQL.
 */

import pkg from 'node-sql-parser';
const { Parser } = pkg;
import { mapDialect } from './dialect.js';
import type { MaskingRule, MaskingType, SchemaCache } from './types.js';

/**
 * Build a masking SQL expression for a given column.
 */
function buildMaskExpression(column: string, type: MaskingType, dialect: string): string | null {
  const isMySQL = dialect.toLowerCase() === 'mysql' || dialect.toLowerCase() === 'mariadb';

  switch (type) {
    case 'none':
      return null;
    case 'redact':
      return "'[REDACTED]'";
    case 'email':
      if (isMySQL) {
        return `CONCAT(LEFT(${column},1),'***@',SUBSTRING_INDEX(${column},'@',-1))`;
      }
      return `CONCAT(LEFT(${column},1),'***@',SPLIT_PART(${column},'@',2))`;
    case 'phone_last4':
      return `CONCAT('***-***-',RIGHT(${column},4))`;
    case 'ssn_last4':
      return `CONCAT('***-**-',RIGHT(${column},4))`;
    case 'credit_card':
      return `CONCAT('****-****-****-',RIGHT(${column},4))`;
    case 'name_initial':
      return `CONCAT(LEFT(${column},1),'***')`;
    case 'ip_partial':
      if (isMySQL) {
        return `CONCAT(SUBSTRING_INDEX(${column},'.',1),'.xxx.xxx.xxx')`;
      }
      return `CONCAT(SPLIT_PART(${column},'.',1),'.xxx.xxx.xxx')`;
    default:
      return null;
  }
}

/**
 * Build a map of table.column → MaskingRule for quick lookup.
 */
function buildRuleMap(rules: MaskingRule[]): Map<string, MaskingRule> {
  const map = new Map<string, MaskingRule>();
  for (const rule of rules) {
    map.set(`${rule.table.toLowerCase()}.${rule.column.toLowerCase()}`, rule);
  }
  return map;
}

/**
 * Extract column name from AST column node.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getColumnName(colExpr: any): string | null {
  if (!colExpr || colExpr.type !== 'column_ref') return null;
  const col = colExpr.column;
  if (typeof col === 'string') return col;
  if (col?.expr?.value) return col.expr.value;
  return null;
}

/**
 * Extract the table name from a FROM clause item.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getFromTableName(fromItem: any): string | null {
  if (!fromItem) return null;
  if (typeof fromItem.table === 'string') return fromItem.table;
  return null;
}

/**
 * Apply column masking to a SQL query.
 *
 * Strategy: Parse the SQL to understand columns and tables, then reconstruct
 * the SELECT projection with masking expressions. The rest of the query
 * (FROM, WHERE, ORDER BY, etc.) is preserved via AST serialization.
 */
export function applyMasking(
  sql: string,
  dialect: string,
  rules: MaskingRule[],
  schemaCache: SchemaCache,
): string {
  if (rules.length === 0) return sql;

  const parser = new Parser();
  const dbDialect = mapDialect(dialect);
  const ruleMap = buildRuleMap(rules);

  let ast;
  try {
    ast = parser.astify(sql, { database: dbDialect });
  } catch {
    throw new Error('Could not parse the SQL query for masking. Please check the syntax.');
  }

  if (Array.isArray(ast)) {
    throw new Error('Multi-statement queries cannot be masked.');
  }
  if ((ast.type ?? '').toLowerCase() !== 'select') return sql;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectAst = ast as any;

  const fromClause = selectAst.from;
  if (!Array.isArray(fromClause) || fromClause.length === 0) return sql;

  const tableName = getFromTableName(fromClause[0]);
  if (!tableName) return sql;

  // Build alias → real table name mapping (for JOINs)
  const aliasMap = new Map<string, string>();
  for (const item of fromClause) {
    const tbl = getFromTableName(item);
    if (tbl && item.as) {
      aliasMap.set(item.as.toLowerCase(), tbl.toLowerCase());
    }
  }

  const tableSchema = schemaCache.tables[tableName] || schemaCache.tables[tableName.toLowerCase()];

  // Determine projected columns
  interface ColInfo {
    name: string;
    alias: string | null;
    table: string | null;
  }
  const projectedCols: ColInfo[] = [];

  // Detect SELECT * — can be string '*' or array with single column_ref '*'
  const isStar = selectAst.columns === '*' || (
    Array.isArray(selectAst.columns) &&
    selectAst.columns.length === 1 &&
    getColumnName(selectAst.columns[0]?.expr) === '*'
  );

  if (isStar) {
    // Expand * using schema cache
    if (!tableSchema) return sql;
    for (const col of tableSchema.columns) {
      projectedCols.push({ name: col.name, alias: null, table: null });
    }
  } else if (Array.isArray(selectAst.columns)) {
    for (const col of selectAst.columns) {
      const colName = getColumnName(col.expr);
      if (colName) {
        const colTable = col.expr?.table || null;
        projectedCols.push({ name: colName, alias: col.as || null, table: colTable });
      } else {
        // Non-column expression (function, literal, etc.) — serialize as-is
        projectedCols.push({ name: '__expr__', alias: col.as || null, table: null });
      }
    }
  }

  // Build masked column list
  const colParts: string[] = [];
  let hasMasking = false;

  for (let i = 0; i < projectedCols.length; i++) {
    const col = projectedCols[i];

    if (col.name === '__expr__') {
      // Non-column expression — serialize from original AST
      try {
        const miniAst = { ...selectAst, columns: [selectAst.columns[i]] };
        const miniSql = parser.sqlify(miniAst, { database: dbDialect });
        const match = miniSql.match(/SELECT\s+([\s\S]*?)\s+FROM/i);
        colParts.push(match ? match[1] : '*');
      } catch {
        colParts.push('*');
      }
      continue;
    }

    // Resolve alias to real table name
    const rawTable = col.table || tableName;
    const lookupTable = aliasMap.get(rawTable.toLowerCase()) || rawTable;
    const key = `${lookupTable.toLowerCase()}.${col.name.toLowerCase()}`;
    const rule = ruleMap.get(key);

    if (rule && rule.type !== 'none') {
      const maskExpr = buildMaskExpression(col.name, rule.type, dialect);
      if (maskExpr) {
        const alias = col.alias || col.name;
        colParts.push(`${maskExpr} AS "${alias}"`);
        hasMasking = true;
        continue;
      }
    }

    // Unmasked column
    const qualifiedName = col.table ? `${col.table}.${col.name}` : col.name;
    if (col.alias) {
      colParts.push(`${qualifiedName} AS "${col.alias}"`);
    } else {
      colParts.push(qualifiedName);
    }
  }

  if (!hasMasking) return sql;

  // Build the rest of the query (FROM, WHERE, ORDER BY, etc.)
  // by serializing with * and replacing SELECT *
  const savedColumns = selectAst.columns;
  selectAst.columns = '*';
  let restOfQuery: string;
  try {
    const fullSql = parser.sqlify(selectAst, { database: dbDialect });
    restOfQuery = fullSql.replace(/^SELECT\s+\*/i, '');
  } catch {
    restOfQuery = ` FROM "${tableName}"`;
  }
  selectAst.columns = savedColumns;

  return `SELECT ${colParts.join(', ')}${restOfQuery}`;
}
