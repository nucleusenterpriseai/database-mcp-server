/**
 * Config File Loader (HTTP mode)
 *
 * Reads YAML or JSON config files for the DB MCP Server binary.
 * Used in HTTP mode (Mode B relay) instead of env var injection.
 *
 * Supports two formats:
 *   - Single database: `database` + `security` sections (original format)
 *   - Multi-database:  `databases` array with per-entry security (new format)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseCredentials, DatabaseConfig } from './types.js';
import { SUPPORTED_DB_TYPES } from './config.js';
import { validateHost } from './host_validator.js';

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

/** Config for a single database instance (used in multi-database mode) */
export interface DatabaseInstanceConfig {
  name: string;
  port: number;
  apiKey: string;
  tls?: { cert: string; key: string };
  credentials: DatabaseCredentials;
  dbConfig: DatabaseConfig;
}

// ─── Raw config shape from YAML/JSON ─────────────────────────────────────────

interface RawDatabaseEntry {
  name?: string;
  server_port?: number;
  type?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  ssl_mode?: string;
  security?: {
    allowed_tables?: string[];
    masking_rules?: Array<{ table: string; column: string; type: string }>;
    row_filters?: Array<{ table: string; condition: string }>;
  };
}

interface RawConfig {
  server?: {
    port?: number;
    api_key?: string;
    tls?: { cert?: string; key?: string };
    allow_private_hosts?: boolean;
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
  databases?: RawDatabaseEntry[];
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

// ─── File reading & parsing ──────────────────────────────────────────────────

async function readAndParseRawConfig(filepath: string): Promise<RawConfig> {
  // Validate path — block path traversal
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
  return expandDeep(raw) as RawConfig;
}

// ─── Database entry validation ───────────────────────────────────────────────

async function validateDatabaseEntry(
  db: RawDatabaseEntry,
  label: string,
  allowPrivateHosts = false,
): Promise<{ credentials: DatabaseCredentials; dbConfig: DatabaseConfig }> {
  if (!db.host) throw new Error(`${label}: host is required`);
  if (!db.port) throw new Error(`${label}: port is required`);
  if (!db.username) throw new Error(`${label}: username is required`);
  if (!db.database) throw new Error(`${label}: database is required`);
  if (!db.type) throw new Error(`${label}: type is required`);
  if (!SUPPORTED_DB_TYPES.includes(db.type as typeof SUPPORTED_DB_TYPES[number])) {
    throw new Error(
      `${label}: db_type must be one of: ${SUPPORTED_DB_TYPES.join(', ')} (got '${db.type}')`,
    );
  }

  // SSRF validation on database host (skipped for self-hosted with allow_private_hosts)
  if (!allowPrivateHosts) {
    const hostCheck = await validateHost(db.host);
    if (!hostCheck.valid) {
      throw new Error(
        `The database host '${db.host}' is not allowed. Private IPs, localhost, and cloud metadata endpoints are blocked. Set server.allow_private_hosts: true for self-hosted deployments.`,
      );
    }
  }

  const credentials: DatabaseCredentials = {
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password ?? '',
    database: db.database,
    ssl_mode: (db.ssl_mode as DatabaseCredentials['ssl_mode']) ?? 'disable',
    db_type: db.type as DatabaseCredentials['db_type'],
  };

  const security = db.security ?? {};
  const dbConfig: DatabaseConfig = {
    db_type: db.type,
    display_name: db.name,
    allowed_tables: security.allowed_tables ?? [],
    masking_rules: (security.masking_rules ?? []) as DatabaseConfig['masking_rules'],
    row_filters: (security.row_filters ?? []) as DatabaseConfig['row_filters'],
  };

  return { credentials, dbConfig };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load and validate config from a YAML or JSON file (single-database format).
 *
 * @param filepath - Path to config file (.yaml, .yml, or .json)
 * @throws Error if file not found, invalid format, or missing required fields
 */
export async function loadConfigFromFile(filepath: string): Promise<FileConfig> {
  const raw = await readAndParseRawConfig(filepath);

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

  // SSRF validation on database host (skipped for self-hosted with allow_private_hosts)
  if (!server?.allow_private_hosts) {
    const hostCheck = await validateHost(db.host);
    if (!hostCheck.valid) {
      throw new Error(
        `The database host '${db.host}' is not allowed. Private IPs, localhost, and cloud metadata endpoints are blocked. Set server.allow_private_hosts: true for self-hosted deployments.`,
      );
    }
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

/**
 * Load config supporting both single-database and multi-database formats.
 *
 * Single-database format uses `database` + `security` sections (returns 1 entry).
 * Multi-database format uses `databases` array (returns N entries, each with
 * its own `server_port` and optional `security` section).
 *
 * @param filepath - Path to config file (.yaml, .yml, or .json)
 * @returns Array of database instance configs, one per database entry
 */
export async function loadAllDatabaseConfigs(filepath: string): Promise<DatabaseInstanceConfig[]> {
  const raw = await readAndParseRawConfig(filepath);

  // Validate server section (api_key always required; port required in single-db mode)
  const server = raw.server;
  if (!server?.api_key) throw new Error('server.api_key is required in config file');

  const tls = server.tls?.cert && server.tls?.key
    ? { cert: server.tls.cert, key: server.tls.key }
    : undefined;

  // ─── Multi-database mode ───────────────────────────────────────────
  if (raw.databases && Array.isArray(raw.databases) && raw.databases.length > 0) {
    const results: DatabaseInstanceConfig[] = [];
    const usedPorts = new Set<number>();
    const usedNames = new Set<string>();

    for (let i = 0; i < raw.databases.length; i++) {
      const entry = raw.databases[i];
      const name = entry.name ?? `db-${i}`;
      const label = `databases[${i}] (${name})`;

      if (usedNames.has(name)) {
        throw new Error(`${label}: duplicate database name '${name}'`);
      }
      usedNames.add(name);

      if (!entry.server_port) {
        throw new Error(`${label}: server_port is required in multi-database mode`);
      }
      if (entry.server_port < 1 || entry.server_port > 65535) {
        throw new Error(`${label}: server_port must be between 1 and 65535 (got ${entry.server_port})`);
      }
      if (usedPorts.has(entry.server_port)) {
        throw new Error(`${label}: duplicate server_port ${entry.server_port}`);
      }
      usedPorts.add(entry.server_port);

      const { credentials, dbConfig } = await validateDatabaseEntry(entry, label, !!server.allow_private_hosts);

      results.push({
        name,
        port: entry.server_port,
        apiKey: server.api_key,
        tls,
        credentials,
        dbConfig,
      });
    }

    return results;
  }

  // ─── Single-database mode (backward compatible) ────────────────────
  if (!server.port) throw new Error('server.port is required in config file');

  const db = raw.database;
  if (!db) throw new Error('Either database or databases section is required in config file');

  const { credentials, dbConfig } = await validateDatabaseEntry(
    { ...db, security: raw.security ?? undefined },
    'database',
    !!server.allow_private_hosts,
  );

  return [{
    name: 'default',
    port: server.port,
    apiKey: server.api_key,
    tls,
    credentials,
    dbConfig,
  }];
}
