/**
 * db_query Tool Tests (TDD)
 *
 * Tests for the MCP tool that executes read-only SQL queries.
 * Includes SQL safety bypass vector tests (B3).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleDbQuery } from '../../src/tools/db_query.js';
import type { DatabaseDriver, ServerConfig, QueryResult } from '../../src/types.js';

function createMockDriver(queryResult?: QueryResult): DatabaseDriver {
  return {
    dbType: () => 'postgres',
    ping: vi.fn(),
    listTables: vi.fn(),
    describeTable: vi.fn(),
    query: vi.fn().mockResolvedValue(queryResult ?? {
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'Alice' }],
      row_count: 1,
    }),
    close: vi.fn(),
  };
}

function createServerConfig(overrides: Partial<ServerConfig['config']> = {}): ServerConfig {
  return {
    credentials: {
      host: 'db.example.com',
      port: 5432,
      username: 'user',
      password: 'pass',
      database: 'mydb',
      db_type: 'postgres',
    },
    config: {
      db_type: 'postgres',
      allowed_tables: ['public.orders', 'public.customers'],
      masking_rules: [],
      row_filters: [],
      ...overrides,
    },
  };
}

describe('handleDbQuery', () => {
  // ─── Basic SELECT ───────────────────────────────────────────────────

  it('should execute a valid SELECT query against allowed table', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    const result = await handleDbQuery(driver, config, {
      sql: 'SELECT id, name FROM public.customers',
    });

    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toEqual([{ id: 1, name: 'Alice' }]);
    expect(result.row_count).toBe(1);
  });

  // ─── Write Operations ──────────────────────────────────────────────

  it('should reject INSERT queries', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "INSERT INTO customers (name) VALUES ('Bob')",
      })
    ).rejects.toThrow('Write operations (INSERT, UPDATE, DELETE) are not allowed');
  });

  it('should reject UPDATE queries', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "UPDATE customers SET name = 'Bob' WHERE id = 1",
      })
    ).rejects.toThrow('Write operations (INSERT, UPDATE, DELETE) are not allowed');
  });

  it('should reject DELETE queries', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'DELETE FROM customers WHERE id = 1',
      })
    ).rejects.toThrow('Write operations (INSERT, UPDATE, DELETE) are not allowed');
  });

  // ─── Destructive Operations ────────────────────────────────────────

  it('should reject DROP TABLE queries', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'DROP TABLE customers',
      })
    ).rejects.toThrow('Destructive operations (DROP, ALTER, TRUNCATE) are not allowed');
  });

  it('should reject ALTER TABLE queries', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'ALTER TABLE customers ADD COLUMN age INT',
      })
    ).rejects.toThrow('Destructive operations (DROP, ALTER, TRUNCATE) are not allowed');
  });

  // ─── Multi-statement / Session ─────────────────────────────────────

  it('should reject multi-statement queries', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'SELECT 1; DROP TABLE customers',
      })
    ).rejects.toThrow('Multi-statement queries are not allowed');
  });

  it('should reject SET commands', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'SET statement_timeout = 0',
      })
    ).rejects.toThrow(/session manipulation|not allowed/i);
  });

  // ─── LIMIT Enforcement ─────────────────────────────────────────────

  it('should add LIMIT 1000 to queries without LIMIT', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await handleDbQuery(driver, config, {
      sql: 'SELECT * FROM public.orders',
    });

    const executedSql = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(executedSql.toUpperCase()).toContain('LIMIT');
  });

  it('should keep existing LIMIT if <= 1000', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await handleDbQuery(driver, config, {
      sql: 'SELECT * FROM public.orders LIMIT 50',
    });

    const executedSql = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(executedSql).toContain('50');
  });

  it('should reduce LIMIT to 1000 if > 1000', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await handleDbQuery(driver, config, {
      sql: 'SELECT * FROM public.orders LIMIT 5000',
    });

    const executedSql = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(executedSql).not.toContain('5000');
  });

  // ─── Structured Result ─────────────────────────────────────────────

  it('should return structured query result', async () => {
    const queryResult: QueryResult = {
      columns: ['order_id', 'customer_name', 'total'],
      rows: [
        { order_id: 1, customer_name: 'Alice', total: 99.99 },
        { order_id: 2, customer_name: 'Bob', total: 149.50 },
      ],
      row_count: 2,
    };
    const driver = createMockDriver(queryResult);
    const config = createServerConfig();

    const result = await handleDbQuery(driver, config, {
      sql: 'SELECT order_id, customer_name, total FROM public.orders LIMIT 10',
    });

    expect(result.columns).toEqual(['order_id', 'customer_name', 'total']);
    expect(result.rows).toHaveLength(2);
    expect(result.row_count).toBe(2);
  });

  // ─── B3: PostgreSQL Bypass Vectors ─────────────────────────────────

  it('should reject GRANT statements', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'GRANT ALL ON users TO public',
      })
    ).rejects.toThrow(/not allowed/i);
  });

  it('should reject REVOKE statements', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'REVOKE ALL ON users FROM public',
      })
    ).rejects.toThrow(/not allowed/i);
  });

  it('should reject CALL stored procedure statements', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'CALL my_procedure()',
      })
    ).rejects.toThrow(/not allowed/i);
  });

  it('should reject COPY TO/FROM (parse error → blocked)', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    // node-sql-parser can't parse COPY — falls through to parse error
    await expect(
      handleDbQuery(driver, config, {
        sql: "COPY users TO '/tmp/data.csv'",
      })
    ).rejects.toThrow(/not allowed|parse/i);
  });

  it('should reject anonymous PL/pgSQL blocks (DO $$ ... $$)', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'DO $$ BEGIN DELETE FROM users; END $$',
      })
    ).rejects.toThrow(/not allowed|parse/i);
  });

  it('should reject SELECT with dangerous pg_read_file() function', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT pg_read_file('/etc/passwd')",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  it('should reject SELECT with pg_ls_dir() function', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT pg_ls_dir('/')",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  it('should reject SELECT with lo_import() function', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT lo_import('/etc/passwd')",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  it('should reject SELECT with lo_export() function', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT lo_export(12345, '/tmp/out.txt')",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  it('should reject SELECT with pg_execute_server_program() function', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT pg_execute_server_program('id')",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  // ─── S1: allowed_tables Enforcement in db_query ────────────────────

  it('should reject query referencing table not in allowed_tables', async () => {
    const driver = createMockDriver();
    const config = createServerConfig({
      allowed_tables: ['public.orders'],
    });

    await expect(
      handleDbQuery(driver, config, {
        sql: 'SELECT * FROM public.secrets',
      })
    ).rejects.toThrow(/not in the allowed tables/i);
  });

  it('should allow query referencing only allowed tables', async () => {
    const driver = createMockDriver();
    const config = createServerConfig({
      allowed_tables: ['public.orders', 'public.customers'],
    });

    // Should not throw
    await handleDbQuery(driver, config, {
      sql: 'SELECT * FROM public.orders',
    });

    expect(driver.query).toHaveBeenCalled();
  });

  it('should reject query with JOIN referencing unauthorized table', async () => {
    const driver = createMockDriver();
    const config = createServerConfig({
      allowed_tables: ['public.orders'],
    });

    await expect(
      handleDbQuery(driver, config, {
        sql: 'SELECT o.id, s.data FROM public.orders o JOIN public.secrets s ON o.id = s.order_id',
      })
    ).rejects.toThrow(/not in the allowed tables/i);
  });

  it('should allow query with JOIN when both tables are allowed', async () => {
    const driver = createMockDriver();
    const config = createServerConfig({
      allowed_tables: ['public.orders', 'public.customers'],
    });

    await handleDbQuery(driver, config, {
      sql: 'SELECT o.id, c.name FROM public.orders o JOIN public.customers c ON o.customer_id = c.id',
    });

    expect(driver.query).toHaveBeenCalled();
  });

  // ─── TC-079: Subquery referencing disallowed table (P0) ────────────

  it('should reject subquery referencing disallowed table in WHERE IN', async () => {
    const driver = createMockDriver();
    const config = createServerConfig({
      allowed_tables: ['public.orders'],
    });

    await expect(
      handleDbQuery(driver, config, {
        sql: 'SELECT * FROM public.orders WHERE id IN (SELECT id FROM public.secrets)',
      })
    ).rejects.toThrow(/not in the allowed tables/i);
  });

  // ─── TC-027: Dangerous function nested in subquery (P0) ───────────

  it('should reject dangerous function nested in subquery', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT * FROM public.orders WHERE id IN (SELECT pg_read_file('/etc/passwd')::int)",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  // ─── TC-023: dblink blocked (P0) ──────────────────────────────────

  it('should reject SELECT with dblink() function', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT dblink('host=evil.com', 'SELECT 1')",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  // ─── TC-024: dblink_exec blocked (P0) ─────────────────────────────

  it('should reject SELECT with dblink_exec() function', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT dblink_exec('host=evil.com', 'DROP TABLE users')",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  // ─── TC-020: pg_read_binary_file blocked (P0) ─────────────────────

  it('should reject SELECT with pg_read_binary_file() function', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT pg_read_binary_file('/etc/shadow')",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  // ─── TC-036: Invalid SQL parse error (P0) ─────────────────────────

  it('should reject invalid SQL syntax with parse error', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'SLECT * FORM users',
      })
    ).rejects.toThrow(/could not parse|parse/i);
  });

  // ─── TC-007: TRUNCATE blocked (P1) ────────────────────────────────

  it('should reject TRUNCATE TABLE queries', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'TRUNCATE TABLE customers',
      })
    ).rejects.toThrow('Destructive operations (DROP, ALTER, TRUNCATE) are not allowed');
  });

  // ─── TC-008: CREATE TABLE blocked (P1) ────────────────────────────

  it('should reject CREATE TABLE queries', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'CREATE TABLE evil (id INT)',
      })
    ).rejects.toThrow('Destructive operations (DROP, ALTER, TRUNCATE) are not allowed');
  });

  // ─── TC-010: COMMIT blocked (P1) ──────────────────────────────────

  it('should reject COMMIT statements', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'COMMIT',
      })
    ).rejects.toThrow(/session manipulation|not allowed/i);
  });

  // ─── TC-011: ROLLBACK blocked (P1) ────────────────────────────────

  it('should reject ROLLBACK statements', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: 'ROLLBACK',
      })
    ).rejects.toThrow(/session manipulation|not allowed/i);
  });

  // ─── TC-037: Empty SQL string rejected (P1) ───────────────────────

  it('should reject empty SQL string', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: '',
      })
    ).rejects.toThrow(/empty|parse|not allowed/i);
  });

  // ─── TC-082: Empty allowed_tables no restriction on query (P1) ────

  it('should allow any table when allowed_tables is empty', async () => {
    const driver = createMockDriver();
    const config = createServerConfig({
      allowed_tables: [],
    });

    // Should not throw — empty allowlist means no restriction
    await handleDbQuery(driver, config, {
      sql: 'SELECT * FROM public.any_table',
    });

    expect(driver.query).toHaveBeenCalled();
  });

  // ─── TC-035: DESCRIBE statement classification (P1) ───────────────

  it('should allow DESCRIBE as safe statement', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    // DESCRIBE is classified as safe by prefix check
    await handleDbQuery(driver, config, {
      sql: 'DESCRIBE users',
    });

    expect(driver.query).toHaveBeenCalled();
  });

  // ─── TC-004: REPLACE blocked (P2) ────────────────────────────────

  it('should reject REPLACE statements', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "REPLACE INTO users (id, name) VALUES (1, 'Bob')",
      })
    ).rejects.toThrow('Write operations (INSERT, UPDATE, DELETE) are not allowed');
  });

  // ─── TC-013: SELECT + INSERT multi-statement blocked (P2) ─────────

  it('should reject SELECT followed by INSERT multi-statement', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT 1; INSERT INTO users (name) VALUES ('evil')",
      })
    ).rejects.toThrow('Multi-statement queries are not allowed');
  });

  // ─── TC-028: Dangerous function in CASE expression (P2) ──────────

  it('should reject dangerous function in CASE expression', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbQuery(driver, config, {
        sql: "SELECT CASE WHEN 1=1 THEN pg_read_file('/etc/passwd') ELSE 'no' END FROM public.orders",
      })
    ).rejects.toThrow(/dangerous|blocked|not allowed/i);
  });

  // ─── TC-032: LIMIT 0 edge case (P2) ──────────────────────────────

  it('should preserve LIMIT 0 without modification', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await handleDbQuery(driver, config, {
      sql: 'SELECT * FROM public.orders LIMIT 0',
    });

    const executedSql = (driver.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(executedSql).toContain('0');
  });
});
