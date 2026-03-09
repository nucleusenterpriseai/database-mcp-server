/**
 * ClickHouse Driver Tests (TDD)
 *
 * Tests for ClickHouseDriver — ClickHouse implementation of DatabaseDriver interface.
 * Uses mocked `@clickhouse/client` to test without a real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @clickhouse/client module
const mockPing = vi.fn();
const mockQuery = vi.fn();
const mockClose = vi.fn();

vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn().mockImplementation(() => ({
    ping: mockPing,
    query: mockQuery,
    close: mockClose,
  })),
}));

import { ClickHouseDriver } from '../../src/drivers/clickhouse.js';
import type { DatabaseCredentials } from '../../src/types.js';

describe('ClickHouseDriver', () => {
  const credentials: DatabaseCredentials = {
    host: 'clickhouse.example.com',
    port: 8123,
    username: 'readonly_user',
    password: 's3cret',
    database: 'analytics',
    ssl_mode: 'disable',
    db_type: 'clickhouse',
  };

  let driver: ClickHouseDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    driver = new ClickHouseDriver(credentials);
  });

  describe('constructor', () => {
    it('should create a driver instance', () => {
      expect(driver).toBeInstanceOf(ClickHouseDriver);
    });

    it('should report dbType as clickhouse', () => {
      expect(driver.dbType()).toBe('clickhouse');
    });
  });

  describe('ping', () => {
    it('should call client.ping() to test connectivity', async () => {
      mockPing.mockResolvedValueOnce({ success: true });

      await driver.ping();

      expect(mockPing).toHaveBeenCalled();
    });

    it('should throw on connection failure', async () => {
      mockPing.mockRejectedValueOnce(new Error('connection refused'));

      await expect(driver.ping()).rejects.toThrow('connection refused');
    });
  });

  describe('listTables', () => {
    it('should return tables from system.tables', async () => {
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ data: [
          { name: 'events', engine: 'MergeTree', total_rows: '150000' },
          { name: 'users', engine: 'MergeTree', total_rows: '5000' },
        ] }),
      });

      const tables = await driver.listTables();

      expect(tables).toHaveLength(2);
      expect(tables[0]).toEqual({
        schema: 'analytics',
        name: 'events',
        type: 'table',
        approximate_row_count: 150000,
      });
    });

    it('should filter by database when schema provided', async () => {
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ data: [] }),
      });

      await driver.listTables('other_db');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining('other_db'),
        }),
      );
    });
  });

  describe('describeTable', () => {
    it('should return column metadata via DESCRIBE TABLE', async () => {
      // DESCRIBE TABLE query
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ data: [
          { name: 'id', type: 'UInt64', default_type: '', default_expression: '', comment: '' },
          { name: 'event_name', type: 'String', default_type: '', default_expression: '', comment: '' },
          { name: 'timestamp', type: 'DateTime', default_type: 'DEFAULT', default_expression: 'now()', comment: '' },
        ] }),
      });
      // Sample rows query
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ data: [
          { id: '1', event_name: 'click', timestamp: '2026-01-01 00:00:00' },
        ] }),
      });

      const desc = await driver.describeTable('analytics', 'events', 1);

      expect(desc.schema).toBe('analytics');
      expect(desc.table).toBe('events');
      expect(desc.columns).toHaveLength(3);
      expect(desc.columns[0]).toEqual({
        name: 'id',
        type: 'UInt64',
        nullable: false,
        default_value: null,
        is_primary_key: false,
      });
      expect(desc.columns[2].default_value).toBe('now()');
      expect(desc.sample_rows).toHaveLength(1);
    });
  });

  describe('query', () => {
    it('should execute query with readonly=1 setting', async () => {
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ data: [
          { id: '1', event_name: 'click' },
        ] }),
      });

      const result = await driver.query('SELECT id, event_name FROM events LIMIT 10');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'SELECT id, event_name FROM events LIMIT 10',
          clickhouse_settings: expect.objectContaining({ readonly: '1' }),
        }),
      );
      expect(result.rows).toEqual([{ id: '1', event_name: 'click' }]);
    });

    it('should extract column names from result rows', async () => {
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ data: [
          { count: '42' },
        ] }),
      });

      const result = await driver.query('SELECT count() as count FROM events');

      expect(result.columns).toEqual(['count']);
      expect(result.row_count).toBe(1);
    });

    it('should return empty result for no rows', async () => {
      mockQuery.mockResolvedValueOnce({
        json: vi.fn().mockResolvedValueOnce({ data: [] }),
      });

      const result = await driver.query('SELECT * FROM events WHERE 1=0');

      expect(result.columns).toEqual([]);
      expect(result.rows).toEqual([]);
      expect(result.row_count).toBe(0);
    });
  });

  describe('close', () => {
    it('should close the client', async () => {
      await driver.close();

      expect(mockClose).toHaveBeenCalled();
    });
  });
});
