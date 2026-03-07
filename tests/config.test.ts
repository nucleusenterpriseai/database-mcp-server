/**
 * Config Tests (TDD)
 *
 * Tests for loadConfig() which reads DB_CREDENTIALS and DB_CONFIG from env vars.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

// Mock host_validator to avoid real DNS lookups in config tests
vi.mock('../src/host_validator.js', () => ({
  validateHost: vi.fn().mockResolvedValue({ valid: true }),
}));

import { validateHost } from '../src/host_validator.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  const validCredentials = JSON.stringify({
    host: 'db.example.com',
    port: 5432,
    username: 'readonly_user',
    password: 's3cret',
    database: 'mydb',
    ssl_mode: 'require',
    db_type: 'postgres',
  });

  const validConfig = JSON.stringify({
    db_type: 'postgres',
    display_name: 'Production Analytics DB',
    allowed_tables: ['public.orders', 'public.customers'],
    masking_rules: [
      { table: 'public.customers', column: 'email', type: 'email' },
    ],
    row_filters: [
      { table: 'public.orders', condition: "status != 'deleted'" },
    ],
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(validateHost).mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should parse valid DB_CREDENTIALS and DB_CONFIG', async () => {
    process.env.DB_CREDENTIALS = validCredentials;
    process.env.DB_CONFIG = validConfig;

    const result = await loadConfig();

    expect(result.credentials.host).toBe('db.example.com');
    expect(result.credentials.port).toBe(5432);
    expect(result.credentials.username).toBe('readonly_user');
    expect(result.credentials.password).toBe('s3cret');
    expect(result.credentials.database).toBe('mydb');
    expect(result.credentials.ssl_mode).toBe('require');
    expect(result.config.allowed_tables).toEqual(['public.orders', 'public.customers']);
    expect(result.config.masking_rules).toHaveLength(1);
    expect(result.config.row_filters).toHaveLength(1);
  });

  it('should throw when DB_CREDENTIALS is missing', async () => {
    process.env.DB_CONFIG = validConfig;

    await expect(loadConfig()).rejects.toThrow('DB_CREDENTIALS environment variable is required');
  });

  it('should throw when DB_CONFIG is missing', async () => {
    process.env.DB_CREDENTIALS = validCredentials;

    await expect(loadConfig()).rejects.toThrow('DB_CONFIG environment variable is required');
  });

  it('should throw when DB_CREDENTIALS is invalid JSON', async () => {
    process.env.DB_CREDENTIALS = 'not-json';
    process.env.DB_CONFIG = validConfig;

    await expect(loadConfig()).rejects.toThrow('DB_CREDENTIALS is not valid JSON');
  });

  it('should throw when DB_CONFIG is invalid JSON', async () => {
    process.env.DB_CREDENTIALS = validCredentials;
    process.env.DB_CONFIG = '{bad json';

    await expect(loadConfig()).rejects.toThrow('DB_CONFIG is not valid JSON');
  });

  it('should throw when host is missing from credentials', async () => {
    process.env.DB_CREDENTIALS = JSON.stringify({
      port: 5432,
      username: 'user',
      password: 'pass',
      database: 'db',
    });
    process.env.DB_CONFIG = validConfig;

    await expect(loadConfig()).rejects.toThrow('DB_CREDENTIALS.host is required');
  });

  it('should throw when port is missing from credentials', async () => {
    process.env.DB_CREDENTIALS = JSON.stringify({
      host: 'db.example.com',
      username: 'user',
      password: 'pass',
      database: 'db',
    });
    process.env.DB_CONFIG = validConfig;

    await expect(loadConfig()).rejects.toThrow('DB_CREDENTIALS.port is required');
  });

  it('should throw when allowed_tables is not an array', async () => {
    process.env.DB_CREDENTIALS = validCredentials;
    process.env.DB_CONFIG = JSON.stringify({
      db_type: 'postgres',
      allowed_tables: 'not-an-array',
      masking_rules: [],
      row_filters: [],
    });

    await expect(loadConfig()).rejects.toThrow('DB_CONFIG.allowed_tables must be an array');
  });

  it('should default masking_rules to empty array if missing', async () => {
    process.env.DB_CREDENTIALS = validCredentials;
    process.env.DB_CONFIG = JSON.stringify({
      db_type: 'postgres',
      allowed_tables: ['public.orders'],
    });

    const result = await loadConfig();
    expect(result.config.masking_rules).toEqual([]);
  });

  it('should default row_filters to empty array if missing', async () => {
    process.env.DB_CREDENTIALS = validCredentials;
    process.env.DB_CONFIG = JSON.stringify({
      db_type: 'postgres',
      allowed_tables: ['public.orders'],
    });

    const result = await loadConfig();
    expect(result.config.row_filters).toEqual([]);
  });

  it('should handle password with special characters', async () => {
    process.env.DB_CREDENTIALS = JSON.stringify({
      host: 'db.example.com',
      port: 5432,
      username: 'user',
      password: 'p@ss#w0rd!&=',
      database: 'mydb',
    });
    process.env.DB_CONFIG = validConfig;

    const result = await loadConfig();
    expect(result.credentials.password).toBe('p@ss#w0rd!&=');
  });

  // ─── S3: db_type Validation ──────────────────────────────────────

  it('should throw when db_type is missing from DB_CONFIG', async () => {
    process.env.DB_CREDENTIALS = validCredentials;
    process.env.DB_CONFIG = JSON.stringify({
      allowed_tables: ['public.orders'],
    });

    await expect(loadConfig()).rejects.toThrow('DB_CONFIG.db_type is required');
  });

  it('should throw when db_type is not a supported value', async () => {
    process.env.DB_CREDENTIALS = validCredentials;
    process.env.DB_CONFIG = JSON.stringify({
      db_type: 'oracle',
      allowed_tables: ['public.orders'],
    });

    await expect(loadConfig()).rejects.toThrow(/DB_CONFIG.db_type must be one of/);
  });

  it('should accept mysql as a valid db_type', async () => {
    process.env.DB_CREDENTIALS = JSON.stringify({
      host: 'db.example.com',
      port: 3306,
      username: 'user',
      password: 'pass',
      database: 'mydb',
      db_type: 'mysql',
    });
    process.env.DB_CONFIG = JSON.stringify({
      db_type: 'mysql',
      allowed_tables: ['mydb.orders'],
    });

    const result = await loadConfig();
    expect(result.config.db_type).toBe('mysql');
  });

  // ─── SSRF Host Validation (C1) ────────────────────────────────────

  it('should reject private IP host via SSRF validation', async () => {
    vi.mocked(validateHost).mockResolvedValueOnce({
      valid: false,
      reason: "Host '10.0.0.5' is blocked: private network",
    });

    process.env.DB_CREDENTIALS = JSON.stringify({
      host: '10.0.0.5',
      port: 5432,
      username: 'user',
      password: 'pass',
      database: 'db',
    });
    process.env.DB_CONFIG = validConfig;

    await expect(loadConfig()).rejects.toThrow(/not allowed/);
  });
});
