/**
 * Config File Loader Tests (Task 1.2)
 *
 * Tests for loadConfigFromFile which reads YAML/JSON config files
 * for HTTP server mode (Mode B relay).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfigFromFile, loadAllDatabaseConfigs } from '../src/config-file.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock host_validator to avoid real DNS lookups
vi.mock('../src/host_validator.js', () => ({
  validateHost: vi.fn().mockResolvedValue({ valid: true }),
}));

describe('loadConfigFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mcp-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(filename: string, content: string): string {
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, content, 'utf-8');
    return filepath;
  }

  const validYaml = `
server:
  port: 8443
  api_key: "${'a'.repeat(64)}"

database:
  type: postgres
  host: localhost
  port: 5432
  username: readonly_user
  password: secret
  database: mydb
  ssl_mode: disable

security:
  allowed_tables:
    - public.orders
    - public.customers
  masking_rules:
    - table: public.customers
      column: email
      type: email
  row_filters:
    - table: public.orders
      condition: "status != 'deleted'"
`;

  it('should parse valid YAML config', async () => {
    const filepath = writeConfig('config.yaml', validYaml);
    const result = await loadConfigFromFile(filepath);

    expect(result.server.port).toBe(8443);
    expect(result.server.api_key).toBe('a'.repeat(64));
    expect(result.credentials.host).toBe('localhost');
    expect(result.credentials.port).toBe(5432);
    expect(result.credentials.username).toBe('readonly_user');
    expect(result.credentials.database).toBe('mydb');
    expect(result.dbConfig.db_type).toBe('postgres');
    expect(result.dbConfig.allowed_tables).toEqual(['public.orders', 'public.customers']);
    expect(result.dbConfig.masking_rules).toHaveLength(1);
    expect(result.dbConfig.row_filters).toHaveLength(1);
  });

  it('should parse valid JSON config', async () => {
    const jsonConfig = JSON.stringify({
      server: { port: 9000, api_key: 'b'.repeat(64) },
      database: {
        type: 'mysql',
        host: 'db.local',
        port: 3306,
        username: 'user',
        password: 'pass',
        database: 'testdb',
        ssl_mode: 'require',
      },
      security: {
        allowed_tables: ['testdb.orders'],
        masking_rules: [],
        row_filters: [],
      },
    });
    const filepath = writeConfig('config.json', jsonConfig);
    const result = await loadConfigFromFile(filepath);

    expect(result.server.port).toBe(9000);
    expect(result.credentials.host).toBe('db.local');
    expect(result.dbConfig.db_type).toBe('mysql');
  });

  it('should throw on missing required fields', async () => {
    const yaml = `
server:
  port: 8443
  api_key: "${'a'.repeat(64)}"
database:
  type: postgres
  host: localhost
`;
    const filepath = writeConfig('bad.yaml', yaml);

    await expect(loadConfigFromFile(filepath)).rejects.toThrow(/port.*required|username.*required/i);
  });

  it('should expand environment variables in config', async () => {
    process.env.TEST_DB_PASSWORD = 'env-secret-123';
    const yaml = `
server:
  port: 8443
  api_key: "${'a'.repeat(64)}"
database:
  type: postgres
  host: localhost
  port: 5432
  username: user
  password: "\${TEST_DB_PASSWORD}"
  database: mydb
security:
  allowed_tables:
    - public.orders
`;
    const filepath = writeConfig('env.yaml', yaml);
    const result = await loadConfigFromFile(filepath);

    expect(result.credentials.password).toBe('env-secret-123');
    delete process.env.TEST_DB_PASSWORD;
  });

  it('should throw on missing config file', async () => {
    await expect(loadConfigFromFile('/nonexistent/config.yaml')).rejects.toThrow(/not found|no such file/i);
  });

  it('should throw on invalid YAML', async () => {
    const filepath = writeConfig('invalid.yaml', '{ bad yaml: [');
    await expect(loadConfigFromFile(filepath)).rejects.toThrow();
  });

  it('should default masking_rules and row_filters to empty arrays', async () => {
    const yaml = `
server:
  port: 8443
  api_key: "${'a'.repeat(64)}"
database:
  type: postgres
  host: localhost
  port: 5432
  username: user
  password: pass
  database: mydb
security:
  allowed_tables:
    - public.orders
`;
    const filepath = writeConfig('minimal.yaml', yaml);
    const result = await loadConfigFromFile(filepath);

    expect(result.dbConfig.masking_rules).toEqual([]);
    expect(result.dbConfig.row_filters).toEqual([]);
  });

  // ─── C1: Path traversal validation ──────────────────────────────────

  it('should reject config path with path traversal (../)', async () => {
    await expect(loadConfigFromFile('/etc/../etc/passwd')).rejects.toThrow(/path traversal/i);
  });

  it('should reject config path with encoded traversal', async () => {
    await expect(loadConfigFromFile('/tmp/..%2F..%2Fetc/passwd')).rejects.toThrow(/path traversal/i);
  });

  // ─── C2: db_type validation ────────────────────────────────────────

  it('should reject unsupported db_type', async () => {
    const yaml = `
server:
  port: 8443
  api_key: "${'a'.repeat(64)}"
database:
  type: oracle
  host: localhost
  port: 1521
  username: user
  password: pass
  database: mydb
security:
  allowed_tables:
    - public.orders
`;
    const filepath = writeConfig('bad-type.yaml', yaml);
    await expect(loadConfigFromFile(filepath)).rejects.toThrow(/db_type must be one of.*postgres.*mysql.*clickhouse/i);
  });

  it('should accept clickhouse as valid db_type', async () => {
    const yaml = `
server:
  port: 8443
  api_key: "${'a'.repeat(64)}"
database:
  type: clickhouse
  host: localhost
  port: 9000
  username: default
  password: pass
  database: analytics
security:
  allowed_tables:
    - analytics.events
`;
    const filepath = writeConfig('ch.yaml', yaml);
    const result = await loadConfigFromFile(filepath);
    expect(result.dbConfig.db_type).toBe('clickhouse');
  });

  // ─── TLS config ────────────────────────────────────────────────────

  it('should support TLS config paths', async () => {
    const yaml = `
server:
  port: 8443
  api_key: "${'a'.repeat(64)}"
  tls:
    cert: /etc/tls/cert.pem
    key: /etc/tls/key.pem
database:
  type: postgres
  host: localhost
  port: 5432
  username: user
  password: pass
  database: mydb
security:
  allowed_tables:
    - public.orders
`;
    const filepath = writeConfig('tls.yaml', yaml);
    const result = await loadConfigFromFile(filepath);

    expect(result.server.tls?.cert).toBe('/etc/tls/cert.pem');
    expect(result.server.tls?.key).toBe('/etc/tls/key.pem');
  });
});

// ─── Multi-database config (loadAllDatabaseConfigs) ──────────────────────────

describe('loadAllDatabaseConfigs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mcp-multi-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(filename: string, content: string): string {
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, content, 'utf-8');
    return filepath;
  }

  it('should load single-database config as one-element array', async () => {
    const yaml = `
server:
  port: 8443
  api_key: "${'a'.repeat(64)}"
database:
  type: postgres
  host: localhost
  port: 5432
  username: user
  password: pass
  database: mydb
security:
  allowed_tables: []
`;
    const filepath = writeConfig('single.yaml', yaml);
    const results = await loadAllDatabaseConfigs(filepath);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('default');
    expect(results[0].port).toBe(8443);
    expect(results[0].credentials.host).toBe('localhost');
    expect(results[0].dbConfig.db_type).toBe('postgres');
    expect(results[0].dbConfig.allowed_tables).toEqual([]);
  });

  it('should load multi-database config with all 3 engines', async () => {
    const yaml = `
server:
  api_key: "${'a'.repeat(64)}"
databases:
  - name: pg
    server_port: 8443
    type: postgres
    host: pg-host
    port: 5432
    username: pguser
    password: pgpass
    database: pgdb
    security:
      allowed_tables: []
  - name: maria
    server_port: 8444
    type: mysql
    host: maria-host
    port: 3306
    username: mariauser
    password: mariapass
    database: mariadb
    security:
      allowed_tables:
        - mariadb.orders
  - name: ch
    server_port: 8445
    type: clickhouse
    host: ch-host
    port: 8123
    username: default
    password: chpass
    database: analytics
    security:
      allowed_tables: []
`;
    const filepath = writeConfig('multi.yaml', yaml);
    const results = await loadAllDatabaseConfigs(filepath);

    expect(results).toHaveLength(3);

    // PostgreSQL
    expect(results[0].name).toBe('pg');
    expect(results[0].port).toBe(8443);
    expect(results[0].credentials.db_type).toBe('postgres');
    expect(results[0].credentials.host).toBe('pg-host');
    expect(results[0].dbConfig.allowed_tables).toEqual([]);

    // MariaDB
    expect(results[1].name).toBe('maria');
    expect(results[1].port).toBe(8444);
    expect(results[1].credentials.db_type).toBe('mysql');
    expect(results[1].credentials.host).toBe('maria-host');
    expect(results[1].dbConfig.allowed_tables).toEqual(['mariadb.orders']);

    // ClickHouse
    expect(results[2].name).toBe('ch');
    expect(results[2].port).toBe(8445);
    expect(results[2].credentials.db_type).toBe('clickhouse');
    expect(results[2].credentials.host).toBe('ch-host');
  });

  it('should share api_key and tls across all database entries', async () => {
    const yaml = `
server:
  api_key: shared-key-123
  tls:
    cert: /etc/tls/cert.pem
    key: /etc/tls/key.pem
databases:
  - name: db1
    server_port: 8443
    type: postgres
    host: host1
    port: 5432
    username: user1
    password: pass1
    database: db1
  - name: db2
    server_port: 8444
    type: mysql
    host: host2
    port: 3306
    username: user2
    password: pass2
    database: db2
`;
    const filepath = writeConfig('shared.yaml', yaml);
    const results = await loadAllDatabaseConfigs(filepath);

    expect(results[0].apiKey).toBe('shared-key-123');
    expect(results[1].apiKey).toBe('shared-key-123');
    expect(results[0].tls?.cert).toBe('/etc/tls/cert.pem');
    expect(results[1].tls?.cert).toBe('/etc/tls/cert.pem');
  });

  it('should reject duplicate database names', async () => {
    const yaml = `
server:
  api_key: key123
databases:
  - name: mydb
    server_port: 8443
    type: postgres
    host: host1
    port: 5432
    username: user
    password: pass
    database: db1
  - name: mydb
    server_port: 8444
    type: mysql
    host: host2
    port: 3306
    username: user
    password: pass
    database: db2
`;
    const filepath = writeConfig('dup-name.yaml', yaml);
    await expect(loadAllDatabaseConfigs(filepath)).rejects.toThrow(/duplicate.*name.*mydb/i);
  });

  it('should reject duplicate server_port values', async () => {
    const yaml = `
server:
  api_key: key123
databases:
  - name: db1
    server_port: 8443
    type: postgres
    host: host1
    port: 5432
    username: user
    password: pass
    database: db1
  - name: db2
    server_port: 8443
    type: mysql
    host: host2
    port: 3306
    username: user
    password: pass
    database: db2
`;
    const filepath = writeConfig('dup-port.yaml', yaml);
    await expect(loadAllDatabaseConfigs(filepath)).rejects.toThrow(/duplicate.*server_port.*8443/i);
  });

  it('should require server_port in multi-database mode', async () => {
    const yaml = `
server:
  api_key: key123
databases:
  - name: db1
    type: postgres
    host: host1
    port: 5432
    username: user
    password: pass
    database: db1
`;
    const filepath = writeConfig('no-port.yaml', yaml);
    await expect(loadAllDatabaseConfigs(filepath)).rejects.toThrow(/server_port.*required/i);
  });

  it('should set display_name from database entry name', async () => {
    const yaml = `
server:
  api_key: key123
databases:
  - name: production-pg
    server_port: 8443
    type: postgres
    host: pg-host
    port: 5432
    username: user
    password: pass
    database: mydb
`;
    const filepath = writeConfig('display.yaml', yaml);
    const results = await loadAllDatabaseConfigs(filepath);
    expect(results[0].dbConfig.display_name).toBe('production-pg');
  });

  it('should default allowed_tables to empty array when security is omitted', async () => {
    const yaml = `
server:
  api_key: key123
databases:
  - name: db1
    server_port: 8443
    type: postgres
    host: host1
    port: 5432
    username: user
    password: pass
    database: mydb
`;
    const filepath = writeConfig('no-security.yaml', yaml);
    const results = await loadAllDatabaseConfigs(filepath);
    expect(results[0].dbConfig.allowed_tables).toEqual([]);
    expect(results[0].dbConfig.masking_rules).toEqual([]);
    expect(results[0].dbConfig.row_filters).toEqual([]);
  });
});
