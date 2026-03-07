/**
 * PostgreSQL Driver
 *
 * Implements DatabaseDriver interface using the `pg` package (node-postgres).
 * All queries run inside a read-only transaction with automatic ROLLBACK.
 */

import { Pool } from 'pg';
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

export class PgDriver implements DatabaseDriver {
  private pool: Pool;

  constructor(credentials: DatabaseCredentials) {
    this.pool = new Pool({
      host: credentials.host,
      port: credentials.port,
      user: credentials.username,
      password: credentials.password,
      database: credentials.database,
      max: MAX_POOL_CONNECTIONS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      ssl: credentials.ssl_mode === 'disable'
        ? false
        : { rejectUnauthorized: credentials.ssl_mode === 'verify-full' || credentials.ssl_mode === 'verify-ca' },
    });
  }

  dbType(): string {
    return 'postgres';
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async listTables(schema = 'public'): Promise<TableMeta[]> {
    const sql = `
      SELECT
        t.table_schema,
        t.table_name,
        t.table_type,
        COALESCE(s.n_live_tup, 0)::int AS approximate_row_count
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s
        ON s.schemaname = t.table_schema AND s.relname = t.table_name
      WHERE t.table_schema = $1
        AND t.table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY t.table_name
    `;

    const result = await this.pool.query(sql, [schema]);

    return result.rows.map((row) => ({
      schema: row.table_schema,
      name: row.table_name,
      type: row.table_type === 'BASE TABLE' ? 'table' as const : 'view' as const,
      approximate_row_count: row.approximate_row_count,
    }));
  }

  /**
   * Escape a PostgreSQL identifier by doubling internal double-quotes.
   */
  private escapeIdentifier(name: string): string {
    return name.replace(/"/g, '""');
  }

  async describeTable(
    schema: string,
    table: string,
    sampleRows = 3,
  ): Promise<TableDescription> {
    // 1. Columns
    const columnsResult = await this.pool.query(
      `
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = $1
          AND tc.table_name = $2
          AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.column_name = c.column_name
      WHERE c.table_schema = $1 AND c.table_name = $2
      ORDER BY c.ordinal_position
      `,
      [schema, table],
    );

    const columns: ColumnMeta[] = columnsResult.rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      default_value: row.column_default,
      is_primary_key: row.is_primary_key,
    }));

    // 2. Constraints
    const constraintsResult = await this.pool.query(
      `
      SELECT
        tc.constraint_name,
        tc.constraint_type,
        array_agg(DISTINCT kcu.column_name) AS column_names,
        ccu.table_schema || '.' || ccu.table_name AS ref_table,
        array_agg(DISTINCT ccu.column_name) FILTER (WHERE tc.constraint_type = 'FOREIGN KEY') AS ref_columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
        AND tc.constraint_type = 'FOREIGN KEY'
      WHERE tc.table_schema = $1 AND tc.table_name = $2
      GROUP BY tc.constraint_name, tc.constraint_type, ccu.table_schema, ccu.table_name
      ORDER BY tc.constraint_name
      `,
      [schema, table],
    );

    const constraints: ConstraintMeta[] = constraintsResult.rows.map((row) => {
      const constraint: ConstraintMeta = {
        name: row.constraint_name,
        type: row.constraint_type as ConstraintMeta['type'],
        columns: row.column_names,
      };
      if (row.constraint_type === 'FOREIGN KEY' && row.ref_table) {
        constraint.references = {
          table: row.ref_table,
          columns: row.ref_columns,
        };
      }
      return constraint;
    });

    // 3. Sample rows (identifiers escaped to prevent SQL injection)
    const identifier = `"${this.escapeIdentifier(schema)}"."${this.escapeIdentifier(table)}"`;
    const sampleResult = await this.pool.query(
      `SELECT * FROM ${identifier} LIMIT ${sampleRows}`,
    );

    return {
      schema,
      table,
      columns,
      constraints,
      sample_rows: sampleResult.rows,
    };
  }

  async query(sql: string, _timeoutMs?: number): Promise<QueryResult> {
    // Pin a single client so BEGIN/query/ROLLBACK all run on the same connection
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const result = await client.query(sql);
      return {
        columns: result.fields.map((f: { name: string }) => f.name),
        rows: result.rows,
        row_count: result.rowCount ?? result.rows.length,
      };
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
