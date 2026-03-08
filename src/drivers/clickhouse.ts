/**
 * ClickHouse Driver
 *
 * Implements DatabaseDriver interface using the `@clickhouse/client` package.
 * ClickHouse has no transaction support — uses readonly=1 setting for safety.
 * Communicates over HTTP (default port 8123).
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client';
import type {
  DatabaseCredentials,
  DatabaseDriver,
  TableMeta,
  TableDescription,
  ColumnMeta,
  QueryResult,
} from '../types.js';
import { STATEMENT_TIMEOUT_MS } from '../config.js';

export class ClickHouseDriver implements DatabaseDriver {
  private client: ClickHouseClient;
  private database: string;

  constructor(credentials: DatabaseCredentials) {
    this.database = credentials.database;
    this.client = createClient({
      url: `${credentials.ssl_mode === 'disable' ? 'http' : 'https'}://${credentials.host}:${credentials.port}`,
      username: credentials.username,
      password: credentials.password,
      database: credentials.database,
      request_timeout: STATEMENT_TIMEOUT_MS,
      clickhouse_settings: {
        readonly: '1',
      },
    });
  }

  dbType(): string {
    return 'clickhouse';
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async listTables(schema?: string): Promise<TableMeta[]> {
    const dbName = schema ?? this.database;

    const result = await this.client.query({
      query: `SELECT name, engine, total_rows FROM system.tables WHERE database = '${dbName.replace(/'/g, "''")}' ORDER BY name`,
      clickhouse_settings: { readonly: '1' },
    });

    const json = (await result.json()) as unknown as { data: Array<{ name: string; engine: string; total_rows: string }> };
    const rows = json.data;

    return rows.map((row) => ({
      schema: dbName,
      name: row.name,
      type: 'table' as const,
      approximate_row_count: Number(row.total_rows) || 0,
    }));
  }

  async describeTable(
    schema: string,
    table: string,
    sampleRows = 3,
  ): Promise<TableDescription> {
    // 1. Column metadata via DESCRIBE TABLE
    const descResult = await this.client.query({
      query: `DESCRIBE TABLE \`${schema.replace(/`/g, '\\`')}\`.\`${table.replace(/`/g, '\\`')}\``,
      clickhouse_settings: { readonly: '1' },
    });

    const descJson = (await descResult.json()) as unknown as { data: Array<{
      name: string;
      type: string;
      default_type: string;
      default_expression: string;
      comment: string;
    }> };
    const descRows = descJson.data;

    const columns: ColumnMeta[] = descRows.map((row) => ({
      name: row.name,
      type: row.type,
      nullable: row.type.startsWith('Nullable('),
      default_value: row.default_expression || null,
      is_primary_key: false, // ClickHouse doesn't expose PK via DESCRIBE
    }));

    // 2. Sample rows
    const sampleResult = await this.client.query({
      query: `SELECT * FROM \`${schema.replace(/`/g, '\\`')}\`.\`${table.replace(/`/g, '\\`')}\` LIMIT ${sampleRows}`,
      clickhouse_settings: { readonly: '1' },
    });

    const sampleJson = (await sampleResult.json()) as unknown as { data: Record<string, unknown>[] };
    const sampleRowData = sampleJson.data;

    return {
      schema,
      table,
      columns,
      constraints: [], // ClickHouse doesn't have traditional constraints
      sample_rows: sampleRowData,
    };
  }

  async query(sql: string, _timeoutMs?: number): Promise<QueryResult> {
    const result = await this.client.query({
      query: sql,
      clickhouse_settings: { readonly: '1' },
    });

    const json = (await result.json()) as unknown as { meta?: Array<{ name: string }>; data: Record<string, unknown>[] };
    const rows = json.data;
    const columns = json.meta ? json.meta.map((m) => m.name) : (rows.length > 0 ? Object.keys(rows[0]) : []);

    return {
      columns,
      rows,
      row_count: rows.length,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
