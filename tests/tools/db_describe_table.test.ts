/**
 * db_describe_table Tool Tests (TDD)
 *
 * Tests for the MCP tool that describes a table's schema and returns sample rows.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleDbDescribeTable } from '../../src/tools/db_describe_table.js';
import type { DatabaseDriver, ServerConfig, TableDescription } from '../../src/types.js';

function createMockDriver(description?: TableDescription): DatabaseDriver {
  return {
    dbType: () => 'postgres',
    ping: vi.fn(),
    listTables: vi.fn(),
    describeTable: vi.fn().mockResolvedValue(description ?? {
      schema: 'public',
      table: 'orders',
      columns: [
        { name: 'id', type: 'integer', nullable: false, default_value: null, is_primary_key: true },
        { name: 'total', type: 'numeric', nullable: true, default_value: '0', is_primary_key: false },
      ],
      constraints: [
        { name: 'orders_pkey', type: 'PRIMARY KEY', columns: ['id'] },
      ],
      sample_rows: [
        { id: 1, total: 99.99 },
      ],
    }),
    query: vi.fn(),
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

describe('handleDbDescribeTable', () => {
  it('should return table description for an allowed table', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    const result = await handleDbDescribeTable(driver, config, { table: 'public.orders' });

    expect(result.schema).toBe('public');
    expect(result.table).toBe('orders');
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0].name).toBe('id');
    expect(result.constraints).toHaveLength(1);
    expect(result.sample_rows).toHaveLength(1);
  });

  it('should reject table not in allowed_tables', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await expect(
      handleDbDescribeTable(driver, config, { table: 'public.secrets' })
    ).rejects.toThrow("Table 'public.secrets' is not in the allowed tables list");
  });

  it('should parse schema.table format correctly', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await handleDbDescribeTable(driver, config, { table: 'public.orders' });

    expect(driver.describeTable).toHaveBeenCalledWith('public', 'orders', 3);
  });

  it('should default to public schema when no schema prefix', async () => {
    const driver = createMockDriver();
    const config = createServerConfig({
      allowed_tables: ['orders'],
    });

    await handleDbDescribeTable(driver, config, { table: 'orders' });

    expect(driver.describeTable).toHaveBeenCalledWith('public', 'orders', 3);
  });

  it('should respect custom sample_rows parameter', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await handleDbDescribeTable(driver, config, { table: 'public.orders', sample_rows: 5 });

    expect(driver.describeTable).toHaveBeenCalledWith('public', 'orders', 5);
  });

  it('should cap sample_rows at MAX_SAMPLE_ROWS', async () => {
    const driver = createMockDriver();
    const config = createServerConfig();

    await handleDbDescribeTable(driver, config, { table: 'public.orders', sample_rows: 100 });

    // Should cap at 10 (MAX_SAMPLE_ROWS)
    expect(driver.describeTable).toHaveBeenCalledWith('public', 'orders', 10);
  });

  it('should return correct column metadata', async () => {
    const desc: TableDescription = {
      schema: 'public',
      table: 'customers',
      columns: [
        { name: 'id', type: 'integer', nullable: false, default_value: null, is_primary_key: true },
        { name: 'email', type: 'varchar', nullable: false, default_value: null, is_primary_key: false },
        { name: 'name', type: 'text', nullable: true, default_value: null, is_primary_key: false },
      ],
      constraints: [],
      sample_rows: [],
    };
    const driver = createMockDriver(desc);
    const config = createServerConfig();

    const result = await handleDbDescribeTable(driver, config, { table: 'public.customers' });

    expect(result.columns).toHaveLength(3);
    expect(result.columns[1]).toEqual({
      name: 'email',
      type: 'varchar',
      nullable: false,
      default_value: null,
      is_primary_key: false,
    });
  });
});
