/**
 * MCP Database Server Configuration
 *
 * Reads DB_CREDENTIALS and DB_CONFIG from environment variables.
 * Used in stdio mode. For HTTP mode, see config-file.ts.
 */

import type { DatabaseCredentials, DatabaseConfig, ServerConfig } from './types.js';
import { validateHost } from './host_validator.js';

export const SERVER_NAME = 'database';
export const SERVER_VERSION = '1.0.0';

/** Maximum rows returned per query */
export const MAX_ROWS = 1000;

/** Statement timeout in milliseconds */
export const STATEMENT_TIMEOUT_MS = 30_000;

/** Max connections per user pool */
export const MAX_POOL_CONNECTIONS = 5;

/** Default sample rows for db_describe_table */
export const DEFAULT_SAMPLE_ROWS = 3;

/** Max sample rows for db_describe_table */
export const MAX_SAMPLE_ROWS = 10;

/** Supported database types */
export const SUPPORTED_DB_TYPES = ['postgres', 'mysql', 'clickhouse'] as const;

/**
 * Load server configuration from environment variables.
 *
 * @throws Error if DB_CREDENTIALS is missing or invalid JSON
 * @throws Error if DB_CONFIG is missing or invalid JSON
 */
export async function loadConfig(): Promise<ServerConfig> {
  const credentialsJson = process.env.DB_CREDENTIALS;
  if (!credentialsJson) {
    throw new Error('DB_CREDENTIALS environment variable is required');
  }

  const configJson = process.env.DB_CONFIG;
  if (!configJson) {
    throw new Error('DB_CONFIG environment variable is required');
  }

  let credentials: DatabaseCredentials;
  try {
    credentials = JSON.parse(credentialsJson) as DatabaseCredentials;
  } catch {
    throw new Error('DB_CREDENTIALS is not valid JSON');
  }

  let config: DatabaseConfig;
  try {
    config = JSON.parse(configJson) as DatabaseConfig;
  } catch {
    throw new Error('DB_CONFIG is not valid JSON');
  }

  // Validate required credential fields
  if (!credentials.host) throw new Error('DB_CREDENTIALS.host is required');
  if (!credentials.port) throw new Error('DB_CREDENTIALS.port is required');
  if (!credentials.username) throw new Error('DB_CREDENTIALS.username is required');
  if (!credentials.database) throw new Error('DB_CREDENTIALS.database is required');

  // SSRF validation on database host
  const hostCheck = await validateHost(credentials.host);
  if (!hostCheck.valid) {
    throw new Error(
      `The database host '${credentials.host}' is not allowed. Private IPs, localhost, and cloud metadata endpoints are blocked.`,
    );
  }

  // Validate db_type
  if (!config.db_type) {
    throw new Error('DB_CONFIG.db_type is required');
  }
  if (!SUPPORTED_DB_TYPES.includes(config.db_type as typeof SUPPORTED_DB_TYPES[number])) {
    throw new Error(
      `DB_CONFIG.db_type must be one of: ${SUPPORTED_DB_TYPES.join(', ')} (got '${config.db_type}')`,
    );
  }

  // Validate config
  if (!Array.isArray(config.allowed_tables)) {
    throw new Error('DB_CONFIG.allowed_tables must be an array');
  }
  if (!Array.isArray(config.masking_rules)) {
    config.masking_rules = [];
  }
  if (!Array.isArray(config.row_filters)) {
    config.row_filters = [];
  }

  return { credentials, config };
}
