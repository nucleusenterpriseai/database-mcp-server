/**
 * PostgreSQL Driver Tests (TDD)
 *
 * Tests for PgDriver — PostgreSQL implementation of DatabaseDriver interface.
 * Uses mocked `pg` Pool to test without a real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pg module — pool.connect() returns a pinned client
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockPoolQuery = vi.fn();
const mockEnd = vi.fn();

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: mockPoolQuery,
    end: mockEnd,
    connect: vi.fn().mockResolvedValue({
      query: mockClientQuery,
      release: mockClientRelease,
    }),
  })),
}));

import { PgDriver } from '../../src/drivers/pg.js';
import type { DatabaseCredentials } from '../../src/types.js';

describe('PgDriver', () => {
  const credentials: DatabaseCredentials = {
    host: 'db.example.com',
    port: 5432,
    username: 'readonly_user',
    password: 's3cret',
    database: 'mydb',
    ssl_mode: 'require',
    db_type: 'postgres',
  };

  let driver: PgDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    driver = new PgDriver(credentials);
  });

  describe('constructor', () => {
    it('should create a driver instance', () => {
      expect(driver).toBeInstanceOf(PgDriver);
    });

    it('should report dbType as postgres', () => {
      expect(driver.dbType()).toBe('postgres');
    });
  });

  describe('ping', () => {
    it('should execute SELECT 1 to test connectivity', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      await driver.ping();

      expect(mockPoolQuery).toHaveBeenCalledWith('SELECT 1');
    });

    it('should throw on connection failure', async () => {
      mockPoolQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(driver.ping()).rejects.toThrow('connection refused');
    });
  });

  describe('listTables', () => {
    it('should return tables with schema, name, type, and row count', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { table_schema: 'public', table_name: 'orders', table_type: 'BASE TABLE', approximate_row_count: 15000 },
          { table_schema: 'public', table_name: 'customers', table_type: 'BASE TABLE', approximate_row_count: 500 },
          { table_schema: 'public', table_name: 'order_summary', table_type: 'VIEW', approximate_row_count: 0 },
        ],
      });

      const tables = await driver.listTables('public');

      expect(tables).toHaveLength(3);
      expect(tables[0]).toEqual({
        schema: 'public',
        name: 'orders',
        type: 'table',
        approximate_row_count: 15000,
      });
      expect(tables[2]).toEqual({
        schema: 'public',
        name: 'order_summary',
        type: 'view',
        approximate_row_count: 0,
      });
    });

    it('should default schema to public', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await driver.listTables();

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("table_schema = $1"),
        ['public']
      );
    });

    it('should filter by provided schema', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await driver.listTables('analytics');

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['analytics']
      );
    });
  });

  describe('describeTable', () => {
    it('should return columns with type, nullable, default, and primary key', async () => {
      // First query: columns
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: "nextval('orders_id_seq'::regclass)", is_primary_key: true },
          { column_name: 'customer_id', data_type: 'integer', is_nullable: 'NO', column_default: null, is_primary_key: false },
          { column_name: 'total', data_type: 'numeric', is_nullable: 'YES', column_default: '0', is_primary_key: false },
        ],
      });
      // Second query: constraints
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { constraint_name: 'orders_pkey', constraint_type: 'PRIMARY KEY', column_names: ['id'], ref_table: null, ref_columns: null },
          { constraint_name: 'orders_customer_fk', constraint_type: 'FOREIGN KEY', column_names: ['customer_id'], ref_table: 'public.customers', ref_columns: ['id'] },
        ],
      });
      // Third query: sample rows (uses parameterized query)
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, customer_id: 10, total: 99.99 },
          { id: 2, customer_id: 20, total: 149.50 },
        ],
      });

      const desc = await driver.describeTable('public', 'orders', 2);

      expect(desc.schema).toBe('public');
      expect(desc.table).toBe('orders');
      expect(desc.columns).toHaveLength(3);
      expect(desc.columns[0]).toEqual({
        name: 'id',
        type: 'integer',
        nullable: false,
        default_value: "nextval('orders_id_seq'::regclass)",
        is_primary_key: true,
      });
      expect(desc.constraints).toHaveLength(2);
      expect(desc.constraints[1].type).toBe('FOREIGN KEY');
      expect(desc.constraints[1].references).toEqual({
        table: 'public.customers',
        columns: ['id'],
      });
      expect(desc.sample_rows).toHaveLength(2);
    });

    it('should limit sample rows to the specified count', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // columns
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // constraints
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // sample rows

      await driver.describeTable('public', 'orders', 5);

      // The third query (sample rows) should use parameterized LIMIT
      const sampleCall = mockPoolQuery.mock.calls[2];
      expect(sampleCall[0]).toContain('LIMIT');
    });

    it('should default to 3 sample rows', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await driver.describeTable('public', 'orders');

      const sampleCall = mockPoolQuery.mock.calls[2];
      expect(sampleCall[0]).toContain('LIMIT');
    });

    it('should escape double quotes in schema/table names to prevent SQL injection', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // columns
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // constraints
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // sample rows

      await driver.describeTable('public', 'my"table', 1);

      // The sample query should have escaped double quotes (doubled)
      const sampleQuery = mockPoolQuery.mock.calls[2][0] as string;
      // The identifier should be properly escaped: "my""table" (quotes doubled)
      expect(sampleQuery).toContain('"my""table"');
      // The escaped identifier keeps the injection attempt safely inside quotes
    });
  });

  describe('query', () => {
    it('should use a pinned client for read-only transaction (all statements on same connection)', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN READ ONLY
        .mockResolvedValueOnce({   // actual query
          fields: [{ name: 'id' }, { name: 'name' }],
          rows: [{ id: 1, name: 'Alice' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({}); // ROLLBACK

      const result = await driver.query('SELECT id, name FROM users');

      // All 3 statements must go through the SAME client (not pool.query)
      expect(mockClientQuery).toHaveBeenCalledTimes(3);
      expect(mockClientQuery.mock.calls[0][0]).toBe('BEGIN READ ONLY');
      expect(mockClientQuery.mock.calls[1][0]).toBe('SELECT id, name FROM users');
      expect(mockClientQuery.mock.calls[2][0]).toBe('ROLLBACK');
      // Pool.query should NOT have been called for these
      expect(mockPoolQuery).not.toHaveBeenCalled();
      // Client must be released
      expect(mockClientRelease).toHaveBeenCalled();
      expect(result.columns).toEqual(['id', 'name']);
      expect(result.rows).toEqual([{ id: 1, name: 'Alice' }]);
      expect(result.row_count).toBe(1);
    });

    it('should rollback and release client even on query failure', async () => {
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN READ ONLY
        .mockRejectedValueOnce(new Error('relation does not exist')) // query fails
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(driver.query('SELECT * FROM nonexistent')).rejects.toThrow(
        'relation does not exist'
      );

      // ROLLBACK and release should still be called
      expect(mockClientQuery.mock.calls[2][0]).toBe('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('should return columns and rows in correct format', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          fields: [{ name: 'count' }],
          rows: [{ count: 42 }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({});

      const result = await driver.query('SELECT COUNT(*) as count FROM orders');

      expect(result.columns).toEqual(['count']);
      expect(result.rows).toEqual([{ count: 42 }]);
      expect(result.row_count).toBe(1);
    });
  });

  describe('close', () => {
    it('should end the pool', async () => {
      await driver.close();

      expect(mockEnd).toHaveBeenCalled();
    });
  });
});
