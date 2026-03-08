/**
 * Init Wizard Module Tests
 *
 * Tests for the pure helper functions exported by the init module:
 * getDefaultPort, getDefaultUsername, buildStdioEnvConfig, buildHttpYamlConfig.
 *
 * Note: runInit() is NOT tested here because it requires interactive prompts
 * and filesystem access.
 */

import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import {
  getDefaultPort,
  getDefaultUsername,
  buildStdioEnvConfig,
  buildHttpYamlConfig,
  type InitAnswers,
} from '../src/init.js';

const sampleAnswers: InitAnswers = {
  transportMode: 'http',
  dbType: 'postgres',
  host: 'db.example.com',
  port: 5432,
  username: 'readonly',
  password: 'super-secret-password-123!',
  database: 'myapp',
  sslMode: 'require',
  httpPort: 8443,
  apiKey: 'generated-api-key-abc123',
};

const stdioAnswers: InitAnswers = {
  ...sampleAnswers,
  transportMode: 'stdio',
};

// ─── getDefaultPort ────────────────────────────────────────────────────────────

describe('getDefaultPort', () => {
  it('should return 5432 for postgres', () => {
    expect(getDefaultPort('postgres')).toBe(5432);
  });

  it('should return 3306 for mysql', () => {
    expect(getDefaultPort('mysql')).toBe(3306);
  });

  it('should return 8123 for clickhouse', () => {
    expect(getDefaultPort('clickhouse')).toBe(8123);
  });

  it('should return 5432 for unknown type', () => {
    expect(getDefaultPort('oracle')).toBe(5432);
  });
});

// ─── getDefaultUsername ────────────────────────────────────────────────────────

describe('getDefaultUsername', () => {
  it('should return postgres for postgres', () => {
    expect(getDefaultUsername('postgres')).toBe('postgres');
  });

  it('should return root for mysql', () => {
    expect(getDefaultUsername('mysql')).toBe('root');
  });

  it('should return default for clickhouse', () => {
    expect(getDefaultUsername('clickhouse')).toBe('default');
  });

  it('should return readonly for unknown type', () => {
    expect(getDefaultUsername('oracle')).toBe('readonly');
  });
});

// ─── buildStdioEnvConfig ───────────────────────────────────────────────────────

describe('buildStdioEnvConfig', () => {
  it('should return an object with credentials and config string properties', () => {
    const result = buildStdioEnvConfig(stdioAnswers);

    expect(result).toHaveProperty('credentials');
    expect(result).toHaveProperty('config');
    expect(typeof result.credentials).toBe('string');
    expect(typeof result.config).toBe('string');
  });

  it('should produce valid JSON for credentials', () => {
    const result = buildStdioEnvConfig(stdioAnswers);
    const creds = JSON.parse(result.credentials);

    expect(creds.host).toBe('db.example.com');
    expect(creds.port).toBe(5432);
    expect(creds.username).toBe('readonly');
    expect(creds.password).toBe('super-secret-password-123!');
    expect(creds.database).toBe('myapp');
    expect(creds.db_type).toBe('postgres');
    expect(creds.ssl_mode).toBe('require');
  });

  it('should produce valid JSON for config containing db_type and empty arrays', () => {
    const result = buildStdioEnvConfig(stdioAnswers);
    const config = JSON.parse(result.config);

    expect(config.db_type).toBe('postgres');
    expect(config.allowed_tables).toEqual([]);
    expect(config.masking_rules).toEqual([]);
    expect(config.row_filters).toEqual([]);
  });

  it('should handle special characters in password (quotes and backslashes)', () => {
    const specialAnswers: InitAnswers = {
      ...stdioAnswers,
      password: 'p@ss"word\\with\'special',
    };
    const result = buildStdioEnvConfig(specialAnswers);

    // Should be valid JSON despite special chars
    const creds = JSON.parse(result.credentials);
    expect(creds.password).toBe('p@ss"word\\with\'special');
  });

  it('should use the correct db_type value from answers', () => {
    const mysqlAnswers: InitAnswers = {
      ...stdioAnswers,
      dbType: 'mysql',
      port: 3306,
    };
    const result = buildStdioEnvConfig(mysqlAnswers);
    const creds = JSON.parse(result.credentials);
    const config = JSON.parse(result.config);

    expect(creds.db_type).toBe('mysql');
    expect(config.db_type).toBe('mysql');
  });
});

// ─── buildHttpYamlConfig ───────────────────────────────────────────────────────

describe('buildHttpYamlConfig', () => {
  it('should return valid parseable YAML', () => {
    const result = buildHttpYamlConfig(sampleAnswers);
    const parsed = yaml.load(result) as Record<string, unknown>;

    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  it('should contain server.port matching httpPort', () => {
    const result = buildHttpYamlConfig(sampleAnswers);
    const parsed = yaml.load(result) as Record<string, Record<string, unknown>>;

    expect(parsed.server.port).toBe(8443);
  });

  it('should contain server.api_key as ${MCP_API_KEY} placeholder', () => {
    const result = buildHttpYamlConfig(sampleAnswers);
    const parsed = yaml.load(result) as Record<string, Record<string, unknown>>;

    expect(parsed.server.api_key).toBe('${MCP_API_KEY}');
  });

  it('should contain database section with correct type, host, port, username', () => {
    const result = buildHttpYamlConfig(sampleAnswers);
    const parsed = yaml.load(result) as Record<string, Record<string, unknown>>;

    expect(parsed.database.type).toBe('postgres');
    expect(parsed.database.host).toBe('db.example.com');
    expect(parsed.database.port).toBe(5432);
    expect(parsed.database.username).toBe('readonly');
  });

  it('should use ${DB_PASSWORD} placeholder for password field', () => {
    const result = buildHttpYamlConfig(sampleAnswers);
    const parsed = yaml.load(result) as Record<string, Record<string, unknown>>;

    expect(parsed.database.password).toBe('${DB_PASSWORD}');
  });

  it('should contain security section with empty allowed_tables, masking_rules, row_filters', () => {
    const result = buildHttpYamlConfig(sampleAnswers);
    const parsed = yaml.load(result) as Record<string, Record<string, unknown>>;

    expect(parsed.security).toBeDefined();
    expect((parsed.security as Record<string, unknown>).allowed_tables).toEqual([]);
    expect((parsed.security as Record<string, unknown>).masking_rules).toEqual([]);
    expect((parsed.security as Record<string, unknown>).row_filters).toEqual([]);
  });
});

// ─── Security ──────────────────────────────────────────────────────────────────

describe('Security', () => {
  it('should NOT include the literal password in generated YAML', () => {
    const result = buildHttpYamlConfig(sampleAnswers);

    expect(result).not.toContain('super-secret-password-123!');
  });

  it('should NOT include the literal API key in generated YAML', () => {
    const result = buildHttpYamlConfig(sampleAnswers);

    expect(result).not.toContain('generated-api-key-abc123');
  });

  it('should use ${DB_PASSWORD} placeholder in YAML', () => {
    const result = buildHttpYamlConfig(sampleAnswers);

    expect(result).toContain('${DB_PASSWORD}');
  });

  it('should use ${MCP_API_KEY} placeholder in YAML', () => {
    const result = buildHttpYamlConfig(sampleAnswers);

    expect(result).toContain('${MCP_API_KEY}');
  });

  it('should include the actual password in stdio env config (expected for local env block)', () => {
    const result = buildStdioEnvConfig(stdioAnswers);
    const creds = JSON.parse(result.credentials);

    expect(creds.password).toBe('super-secret-password-123!');
  });
});
