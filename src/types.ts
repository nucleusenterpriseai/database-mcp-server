/**
 * Database Connector Types
 *
 * Shared type definitions for the MCP database server.
 */

// ─── Credentials & Configuration ────────────────────────────────────────────

/** Database credentials (DB_CREDENTIALS env var in stdio mode) */
export interface DatabaseCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl_mode?: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  db_type: 'postgres' | 'postgresql' | 'mysql' | 'mariadb' | 'clickhouse';
}

/** Connector configuration (DB_CONFIG env var in stdio mode) */
export interface DatabaseConfig {
  db_type: string;
  display_name?: string;
  allowed_tables: string[];
  masking_rules: MaskingRule[];
  json_path_masking_rules: JsonPathMaskingRule[];
  row_filters: RowFilter[];
  schema_cache?: SchemaCache;
  schema_cached_at?: string;
}

/** Column masking rule */
export interface MaskingRule {
  table: string;
  column: string;
  type: MaskingType;
}

/** Supported masking types */
export type MaskingType =
  | 'email'
  | 'phone_last4'
  | 'ssn_last4'
  | 'credit_card'
  | 'name_initial'
  | 'ip_partial'
  | 'redact'
  | 'none';

/** JSON-path masking rule — masks specific paths within a JSON column */
export interface JsonPathMaskingRule {
  table: string;
  column: string;
  paths: JsonPathMask[];
}

/** A single path+mask pair for JSON-path masking */
export interface JsonPathMask {
  path: string;
  mask: MaskingType;
}

/** Row filter rule */
export interface RowFilter {
  table: string;
  condition: string;
}

/** Cached schema metadata */
export interface SchemaCache {
  tables: Record<string, CachedTableSchema>;
}

/** Cached column info for a table */
export interface CachedTableSchema {
  columns: ColumnMeta[];
}

// ─── Schema Discovery ───────────────────────────────────────────────────────

/** Table metadata returned by db_list_tables */
export interface TableMeta {
  schema: string;
  name: string;
  type: 'table' | 'view';
  approximate_row_count: number;
}

/** Column metadata returned by db_describe_table */
export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
  is_primary_key: boolean;
}

/** Table description returned by db_describe_table */
export interface TableDescription {
  schema: string;
  table: string;
  columns: ColumnMeta[];
  constraints: ConstraintMeta[];
  sample_rows: Record<string, unknown>[];
}

/** Constraint metadata */
export interface ConstraintMeta {
  name: string;
  type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';
  columns: string[];
  references?: {
    table: string;
    columns: string[];
  };
}

// ─── Query Results ──────────────────────────────────────────────────────────

/** Result from db_query */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
}

// ─── Driver Interface ───────────────────────────────────────────────────────

/** Database driver interface — implemented per database type */
export interface DatabaseDriver {
  dbType(): string;
  ping(): Promise<void>;
  listTables(schema?: string): Promise<TableMeta[]>;
  describeTable(schema: string, table: string, sampleRows?: number): Promise<TableDescription>;
  query(sql: string, timeoutMs?: number): Promise<QueryResult>;
  close(): Promise<void>;
}

// ─── Server Configuration ───────────────────────────────────────────────────

/** Combined server configuration parsed from env vars */
export interface ServerConfig {
  credentials: DatabaseCredentials;
  config: DatabaseConfig;
}
