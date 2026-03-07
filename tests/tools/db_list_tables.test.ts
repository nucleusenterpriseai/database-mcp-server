/**
 * db_list_tables Tool Tests (TDD)
 *
 * Tests for the MCP tool that lists tables/views in the connected database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDbListTables } from '../../src/tools/db_list_tables.js';
import type { DatabaseDriver, ServerConfig, TableMeta } from '../../src/types.js';

function createMockDriver(tables: TableMeta[] = []): DatabaseDriver {
  return {
    dbType: () => 'postgres',
    ping: vi.fn(),
    listTables: vi.fn().mockResolvedValue(tables),
    describeTable: vi.fn(),
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
      allowed_tables: ['public.orders', 'public.customers', 'public.products'],
      masking_rules: [],
      row_filters: [],
      ...overrides,
    },
  };
}

describe('handleDbListTables', () => {
  it('should return only tables in allowed_tables list', async () => {
    const allTables: TableMeta[] = [
      { schema: 'public', name: 'orders', type: 'table', approximate_row_count: 15000 },
      { schema: 'public', name: 'customers', type: 'table', approximate_row_count: 500 },
      { schema: 'public', name: 'products', type: 'table', approximate_row_count: 200 },
      { schema: 'public', name: 'secrets', type: 'table', approximate_row_count: 10 },
    ];
    const driver = createMockDriver(allTables);
    const config = createServerConfig();

    const result = await handleDbListTables(driver, config, {});

    expect(result).toHaveLength(3);
    expect(result.map(t => t.name)).toEqual(['orders', 'customers', 'products']);
    // 'secrets' should be filtered out
    expect(result.find(t => t.name === 'secrets')).toBeUndefined();
  });

  it('should filter by schema when provided', async () => {
    const tables: TableMeta[] = [
      { schema: 'analytics', name: 'events', type: 'table', approximate_row_count: 100000 },
    ];
    const driver = createMockDriver(tables);
    const config = createServerConfig({
      allowed_tables: ['analytics.events', 'public.orders'],
    });

    const result = await handleDbListTables(driver, config, { schema: 'analytics' });

    expect(driver.listTables).toHaveBeenCalledWith('analytics');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('events');
  });

  it('should return empty array when no tables match allowed list', async () => {
    const tables: TableMeta[] = [
      { schema: 'public', name: 'internal_data', type: 'table', approximate_row_count: 100 },
    ];
    const driver = createMockDriver(tables);
    const config = createServerConfig({
      allowed_tables: ['public.orders'],
    });

    const result = await handleDbListTables(driver, config, {});

    expect(result).toHaveLength(0);
  });

  it('should include views in results', async () => {
    const tables: TableMeta[] = [
      { schema: 'public', name: 'orders', type: 'table', approximate_row_count: 15000 },
      { schema: 'public', name: 'order_summary', type: 'view', approximate_row_count: 0 },
    ];
    const driver = createMockDriver(tables);
    const config = createServerConfig({
      allowed_tables: ['public.orders', 'public.order_summary'],
    });

    const result = await handleDbListTables(driver, config, {});

    expect(result).toHaveLength(2);
    expect(result[1].type).toBe('view');
  });

  it('should handle tables without schema prefix in allowed_tables', async () => {
    const tables: TableMeta[] = [
      { schema: 'public', name: 'orders', type: 'table', approximate_row_count: 100 },
    ];
    const driver = createMockDriver(tables);
    const config = createServerConfig({
      allowed_tables: ['orders'],  // no schema prefix
    });

    const result = await handleDbListTables(driver, config, {});

    // Should match when allowed_tables entry has no schema prefix
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('orders');
  });

  // ─── TC-061: Empty allowed_tables returns all tables (P1) ──────────

  it('should return all tables when allowed_tables is empty', async () => {
    const allTables: TableMeta[] = [
      { schema: 'public', name: 'orders', type: 'table', approximate_row_count: 1000 },
      { schema: 'public', name: 'secrets', type: 'table', approximate_row_count: 10 },
    ];
    const driver = createMockDriver(allTables);
    const config = createServerConfig({
      allowed_tables: [],
    });

    const result = await handleDbListTables(driver, config, {});

    // Empty allowlist means no filtering — return all tables
    expect(result).toHaveLength(2);
    expect(result.map(t => t.name)).toEqual(['orders', 'secrets']);
  });

  // ─── S2: Multi-schema Support ──────────────────────────────────────

  it('should query all distinct schemas from allowed_tables when no schema filter provided', async () => {
    const driver = createMockDriver([]);
    const config = createServerConfig({
      allowed_tables: ['public.orders', 'analytics.events', 'public.customers'],
    });

    await handleDbListTables(driver, config, {});

    // Should call listTables for each distinct schema
    expect(driver.listTables).toHaveBeenCalledWith('public');
    expect(driver.listTables).toHaveBeenCalledWith('analytics');
    expect(driver.listTables).toHaveBeenCalledTimes(2);
  });

  it('should merge results from multiple schemas and filter by allowed_tables', async () => {
    // First call returns public tables, second returns analytics tables
    const publicTables: TableMeta[] = [
      { schema: 'public', name: 'orders', type: 'table', approximate_row_count: 1000 },
      { schema: 'public', name: 'secrets', type: 'table', approximate_row_count: 5 },
    ];
    const analyticsTables: TableMeta[] = [
      { schema: 'analytics', name: 'events', type: 'table', approximate_row_count: 50000 },
      { schema: 'analytics', name: 'internal_logs', type: 'table', approximate_row_count: 200 },
    ];
    const driver = createMockDriver([]);
    (driver.listTables as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(publicTables)
      .mockResolvedValueOnce(analyticsTables);

    const config = createServerConfig({
      allowed_tables: ['public.orders', 'analytics.events'],
    });

    const result = await handleDbListTables(driver, config, {});

    // Only allowed tables from both schemas
    expect(result).toHaveLength(2);
    expect(result.map(t => `${t.schema}.${t.name}`)).toEqual(['public.orders', 'analytics.events']);
  });
});
