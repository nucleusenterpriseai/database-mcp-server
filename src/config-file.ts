/**
 * Config File Loader (HTTP mode)
 *
 * Reads YAML or JSON config files for the DB MCP Server binary.
 * Used in HTTP mode (Mode B relay) instead of env var injection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseCredentials, DatabaseConfig } from './types.js';
import { SUPPORTED_DB_TYPES } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HttpServerConfig {
  port: number;
  api_key: string;
  tls?: {
    cert: string;
    key: string;
  };
}

export interface FileConfig {
  server: HttpServerConfig;
  credentials: DatabaseCredentials;
  dbConfig: DatabaseConfig;
}

// ─── Raw config shape from YAML/JSON ─────────────────────────────────────────

interface RawConfig {
  server?: {
    port?: number;
    api_key?: string;
    tls?: { cert?: string; key?: string };
  };
  database?: {
    type?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    database?: string;
    ssl_mode?: string;
  };
  security?: {
    allowed_tables?: string[];
    masking_rules?: Array<{ table: string; column: string; type: string }>;
    row_filters?: Array<{ table: string; condition: string }>;
  };
}

// ─── Environment variable expansion ──────────────────────────────────────────

function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

function expandDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return expandEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(expandDeep);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = expandDeep(v);
    }
    return result;
  }
  return obj;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load and validate config from a YAML or JSON file.
 *
 * @param filepath - Path to config file (.yaml, .yml, or .json)
 * @throws Error if file not found, invalid format, or missing required fields
 */
export async function loadConfigFromFile(filepath: string): Promise<FileConfig> {
  // C1: Validate path — block path traversal
  const decoded = decodeURIComponent(filepath);
  const resolved = path.resolve(decoded);
  if (decoded.includes('..') || resolved !== path.resolve(filepath)) {
    throw new Error(`Config path traversal detected: '${filepath}' is not allowed`);
  }

  // Read file
  let content: string;
  try {
    content = fs.readFileSync(filepath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Config file not found: ${filepath} (${msg})`);
  }

  // Parse YAML or JSON
  let raw: RawConfig;
  const ext = path.extname(filepath).toLowerCase();
  if (ext === '.json') {
    try {
      raw = JSON.parse(content) as RawConfig;
    } catch {
      throw new Error(`Invalid JSON in config file: ${filepath}`);
    }
  } else {
    // YAML — use dynamic import to avoid bundling issues
    let yaml: { load: (s: string) => unknown };
    try {
      yaml = await import('js-yaml');
    } catch {
      throw new Error('js-yaml package is required for YAML config files. Install with: npm install js-yaml');
    }
    try {
      raw = yaml.load(content) as RawConfig;
    } catch {
      throw new Error(`Invalid YAML in config file: ${filepath}`);
    }
  }

  // Expand env vars
  raw = expandDeep(raw) as RawConfig;

  // Validate server section
  const server = raw.server;
  if (!server?.port) throw new Error('server.port is required in config file');
  if (!server.api_key) throw new Error('server.api_key is required in config file');

  // Validate database section
  const db = raw.database;
  if (!db?.host) throw new Error('database.host is required in config file');
  if (!db.port) throw new Error('database.port is required in config file');
  if (!db.username) throw new Error('database.username is required in config file');
  if (!db.database) throw new Error('database.database is required in config file');
  if (!db.type) throw new Error('database.type is required in config file');
  if (!SUPPORTED_DB_TYPES.includes(db.type as typeof SUPPORTED_DB_TYPES[number])) {
    throw new Error(
      `database.db_type must be one of: ${SUPPORTED_DB_TYPES.join(', ')} (got '${db.type}')`,
    );
  }

  // Build credentials
  const credentials: DatabaseCredentials = {
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password ?? '',
    database: db.database,
    ssl_mode: (db.ssl_mode as DatabaseCredentials['ssl_mode']) ?? 'disable',
    db_type: db.type as DatabaseCredentials['db_type'],
  };

  // Build config
  const security = raw.security ?? {};
  const dbConfig: DatabaseConfig = {
    db_type: db.type,
    allowed_tables: security.allowed_tables ?? [],
    masking_rules: (security.masking_rules ?? []) as DatabaseConfig['masking_rules'],
    row_filters: (security.row_filters ?? []) as DatabaseConfig['row_filters'],
  };

  // Build server config
  const serverConfig: HttpServerConfig = {
    port: server.port,
    api_key: server.api_key,
    tls: server.tls?.cert && server.tls?.key
      ? { cert: server.tls.cert, key: server.tls.key }
      : undefined,
  };

  return { server: serverConfig, credentials, dbConfig };
}
