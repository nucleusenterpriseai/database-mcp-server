/**
 * MySQL Driver Tests (TDD)
 *
 * Tests for MysqlDriver — MySQL/MariaDB implementation of DatabaseDriver interface.
 * Uses mocked `mysql2/promise` to test without a real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mysql2/promise module
const mockQuery = vi.fn();
const mockEnd = vi.fn();
const mockGetConnection = vi.fn();
const mockConnQuery = vi.fn();
const mockConnRelease = vi.fn();

vi.mock('mysql2/promise', () => ({
  createPool: vi.fn().mockImplementation(() => ({
    query: mockQuery,
    end: mockEnd,
    getConnection: mockGetConnection.mockResolvedValue({
      query: mockConnQuery,
      release: mockConnRelease,
    }),
    pool: { config: { connectionConfig: { database: 'mydb' } } },
  })),
}));

import { MysqlDriver } from '../../src/drivers/mysql.js';
import type { DatabaseCredentials } from '../../src/types.js';

describe('MysqlDriver', () => {
  const credentials: DatabaseCredentials = {
    host: 'mysql.example.com',
    port: 3306,
    username: 'readonly_user',
    password: 's3cret',
    database: 'mydb',
    ssl_mode: 'require',
    db_type: 'mysql',
  };

  let driver: MysqlDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    driver = new MysqlDriver(credentials);
  });

  describe('constructor', () => {
    it('should create a driver instance', () => {
      expect(driver).toBeInstanceOf(MysqlDriver);
    });

    it('should report dbType as mysql', () => {
      expect(driver.dbType()).toBe('mysql');
    });
  });

  describe('ping', () => {
    it('should execute SELECT 1 to test connectivity', async () => {
      mockQuery.mockResolvedValueOnce([[{ '1': 1 }], []]);

      await driver.ping();

      expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
    });

    it('should throw on connection failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(driver.ping()).rejects.toThrow('connection refused');
    });
  });

  describe('listTables', () => {
    it('should return tables from information_schema', async () => {
      mockQuery.mockResolvedValueOnce([
        [
          { TABLE_SCHEMA: 'mydb', TABLE_NAME: 'orders', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 15000 },
          { TABLE_SCHEMA: 'mydb', TABLE_NAME: 'customers', TABLE_TYPE: 'BASE TABLE', TABLE_ROWS: 500 },
          { TABLE_SCHEMA: 'mydb', TABLE_NAME: 'order_summary', TABLE_TYPE: 'VIEW', TABLE_ROWS: null },
        ],
        [],
      ]);

      const tables = await driver.listTables('mydb');

      expect(tables).toHaveLength(3);
      expect(tables[0]).toEqual({
        schema: 'mydb',
        name: 'orders',
        type: 'table',
        approximate_row_count: 15000,
      });
      expect(tables[2]).toEqual({
        schema: 'mydb',
        name: 'order_summary',
        type: 'view',
        approximate_row_count: 0,
      });
    });

    it('should use the database name as default schema', async () => {
      mockQuery.mockResolvedValueOnce([[], []]);

      await driver.listTables();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('TABLE_SCHEMA = ?'),
        [credentials.database],
      );
    });
  });

  describe('describeTable', () => {
    it('should return columns with type, nullable, default, and primary key', async () => {
      // Columns query
      mockQuery.mockResolvedValueOnce([
        [
          { COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI' },
          { COLUMN_NAME: 'name', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, COLUMN_KEY: '' },
        ],
        [],
      ]);
      // Constraints query
      mockQuery.mockResolvedValueOnce([
        [
          { CONSTRAINT_NAME: 'PRIMARY', CONSTRAINT_TYPE: 'PRIMARY KEY', COLUMN_NAME: 'id', REFERENCED_TABLE_SCHEMA: null, REFERENCED_TABLE_NAME: null, REFERENCED_COLUMN_NAME: null },
        ],
        [],
      ]);
      // Sample rows query
      mockConnQuery.mockResolvedValueOnce([
        [{ id: 1, name: 'Alice' }],
        [],
      ]);

      const desc = await driver.describeTable('mydb', 'orders', 1);

      expect(desc.schema).toBe('mydb');
      expect(desc.table).toBe('orders');
      expect(desc.columns).toHaveLength(2);
      expect(desc.columns[0]).toEqual({
        name: 'id',
        type: 'int',
        nullable: false,
        default_value: null,
        is_primary_key: true,
      });
      expect(desc.sample_rows).toHaveLength(1);
    });
  });

  describe('query', () => {
    it('should wrap in read-only transaction using pinned connection', async () => {
      mockConnQuery
        .mockResolvedValueOnce([[], []]) // SET SESSION TRANSACTION READ ONLY
        .mockResolvedValueOnce([[], []]) // START TRANSACTION
        .mockResolvedValueOnce([
          [{ id: 1, name: 'Alice' }],
          [{ name: 'id' }, { name: 'name' }],
        ]) // actual query
        .mockResolvedValueOnce([[], []]); // ROLLBACK

      const result = await driver.query('SELECT id, name FROM users');

      expect(mockConnQuery).toHaveBeenCalledTimes(4);
      expect(mockConnQuery.mock.calls[0][0]).toBe('SET SESSION TRANSACTION READ ONLY');
      expect(mockConnQuery.mock.calls[1][0]).toBe('START TRANSACTION');
      expect(mockConnQuery.mock.calls[2][0]).toBe('SELECT id, name FROM users');
      expect(mockConnQuery.mock.calls[3][0]).toBe('ROLLBACK');
      expect(mockConnRelease).toHaveBeenCalled();
      expect(result.rows).toEqual([{ id: 1, name: 'Alice' }]);
    });

    it('should rollback and release connection even on query failure', async () => {
      mockConnQuery
        .mockResolvedValueOnce([[], []]) // SET SESSION
        .mockResolvedValueOnce([[], []]) // START TRANSACTION
        .mockRejectedValueOnce(new Error("Table 'mydb.nonexistent' doesn't exist"))
        .mockResolvedValueOnce([[], []]); // ROLLBACK

      await expect(driver.query('SELECT * FROM nonexistent')).rejects.toThrow(
        "doesn't exist",
      );

      expect(mockConnQuery.mock.calls[3][0]).toBe('ROLLBACK');
      expect(mockConnRelease).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should end the pool', async () => {
      await driver.close();

      expect(mockEnd).toHaveBeenCalled();
    });
  });

  describe('ssl configuration', () => {
    it('should disable SSL when ssl_mode is disable', () => {
      const disabledCreds: DatabaseCredentials = { ...credentials, ssl_mode: 'disable' };
      const disabledDriver = new MysqlDriver(disabledCreds);
      expect(disabledDriver).toBeInstanceOf(MysqlDriver);
    });
  });
});
