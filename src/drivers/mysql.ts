/**
 * MySQL / MariaDB Driver
 *
 * Implements DatabaseDriver interface using the `mysql2` package.
 * All queries run inside a read-only transaction with automatic ROLLBACK.
 */

import * as mysql from 'mysql2/promise';
import type {
  DatabaseCredentials,
  DatabaseDriver,
  TableMeta,
  TableDescription,
  ColumnMeta,
  ConstraintMeta,
  QueryResult,
} from '../types.js';
import { MAX_POOL_CONNECTIONS, STATEMENT_TIMEOUT_MS } from '../config.js';

export class MysqlDriver implements DatabaseDriver {
  private pool: mysql.Pool;

  constructor(credentials: DatabaseCredentials) {
    this.pool = mysql.createPool({
      host: credentials.host,
      port: credentials.port,
      user: credentials.username,
      password: credentials.password,
      database: credentials.database,
      connectionLimit: MAX_POOL_CONNECTIONS,
      connectTimeout: STATEMENT_TIMEOUT_MS,
      ssl: credentials.ssl_mode === 'disable'
        ? undefined
        : { rejectUnauthorized: credentials.ssl_mode === 'verify-full' || credentials.ssl_mode === 'verify-ca' },
    });
  }

  dbType(): string {
    return 'mysql';
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async listTables(schema?: string): Promise<TableMeta[]> {
    const dbName = schema ?? ((this.pool.pool.config as unknown as { connectionConfig?: { database?: string } }).connectionConfig?.database) ?? 'mysql';

    const sql = `
      SELECT
        TABLE_SCHEMA,
        TABLE_NAME,
        TABLE_TYPE,
        TABLE_ROWS
      FROM information_schema.tables
      WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      ORDER BY TABLE_NAME
    `;

    const [rows] = await this.pool.query(sql, [dbName]);

    return (rows as Record<string, unknown>[]).map((row) => ({
      schema: row.TABLE_SCHEMA as string,
      name: row.TABLE_NAME as string,
      type: (row.TABLE_TYPE === 'BASE TABLE' ? 'table' : 'view') as 'table' | 'view',
      approximate_row_count: Number(row.TABLE_ROWS) || 0,
    }));
  }

  private escapeIdentifier(name: string): string {
    return name.replace(/`/g, '``');
  }

  async describeTable(
    schema: string,
    table: string,
    sampleRows = 3,
  ): Promise<TableDescription> {
    // 1. Columns
    const [columnRows] = await this.pool.query(
      `
      SELECT
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_KEY
      FROM information_schema.columns
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
      `,
      [schema, table],
    );

    const columns: ColumnMeta[] = (columnRows as Record<string, unknown>[]).map((row) => ({
      name: row.COLUMN_NAME as string,
      type: row.DATA_TYPE as string,
      nullable: row.IS_NULLABLE === 'YES',
      default_value: row.COLUMN_DEFAULT as string | null,
      is_primary_key: row.COLUMN_KEY === 'PRI',
    }));

    // 2. Constraints
    const [constraintRows] = await this.pool.query(
      `
      SELECT
        tc.CONSTRAINT_NAME,
        tc.CONSTRAINT_TYPE,
        kcu.COLUMN_NAME,
        kcu.REFERENCED_TABLE_SCHEMA,
        kcu.REFERENCED_TABLE_NAME,
        kcu.REFERENCED_COLUMN_NAME
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        AND tc.TABLE_NAME = kcu.TABLE_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
      ORDER BY tc.CONSTRAINT_NAME
      `,
      [schema, table],
    );

    // Group constraint rows by constraint name
    const constraintMap = new Map<string, ConstraintMeta>();
    for (const row of constraintRows as Record<string, unknown>[]) {
      const name = row.CONSTRAINT_NAME as string;
      if (!constraintMap.has(name)) {
        const constraint: ConstraintMeta = {
          name,
          type: row.CONSTRAINT_TYPE as ConstraintMeta['type'],
          columns: [],
        };
        if (row.CONSTRAINT_TYPE === 'FOREIGN KEY' && row.REFERENCED_TABLE_NAME) {
          constraint.references = {
            table: `${row.REFERENCED_TABLE_SCHEMA}.${row.REFERENCED_TABLE_NAME}`,
            columns: [],
          };
        }
        constraintMap.set(name, constraint);
      }
      const constraint = constraintMap.get(name)!;
      constraint.columns.push(row.COLUMN_NAME as string);
      if (constraint.references && row.REFERENCED_COLUMN_NAME) {
        constraint.references.columns.push(row.REFERENCED_COLUMN_NAME as string);
      }
    }

    // 3. Sample rows (identifiers escaped to prevent SQL injection)
    const conn = await this.pool.getConnection();
    let sampleRowData: Record<string, unknown>[] = [];
    try {
      const identifier = `\`${this.escapeIdentifier(schema)}\`.\`${this.escapeIdentifier(table)}\``;
      const [rows] = await conn.query(`SELECT * FROM ${identifier} LIMIT ${sampleRows}`);
      sampleRowData = rows as Record<string, unknown>[];
    } finally {
      conn.release();
    }

    return {
      schema,
      table,
      columns,
      constraints: Array.from(constraintMap.values()),
      sample_rows: sampleRowData,
    };
  }

  async query(sql: string, _timeoutMs?: number): Promise<QueryResult> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query('SET SESSION TRANSACTION READ ONLY');
      await conn.query('START TRANSACTION');
      const [rows, fields] = await conn.query(sql);
      const resultRows = rows as Record<string, unknown>[];
      const resultFields = fields as Array<{ name: string }> | undefined;
      return {
        columns: resultFields ? resultFields.map((f) => f.name) : Object.keys(resultRows[0] ?? {}),
        rows: resultRows,
        row_count: resultRows.length,
      };
    } finally {
      await conn.query('ROLLBACK');
      conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
