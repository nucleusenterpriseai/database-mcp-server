/**
 * createDriver() factory tests
 *
 * Verifies that the driver factory returns the correct driver instance
 * for each supported database type.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock all driver constructors to avoid real connections
vi.mock('../src/drivers/pg.js', () => ({
  PgDriver: vi.fn().mockImplementation(() => ({ dbType: () => 'postgres' })),
}));
vi.mock('../src/drivers/mysql.js', () => ({
  MysqlDriver: vi.fn().mockImplementation(() => ({ dbType: () => 'mysql' })),
}));
vi.mock('../src/drivers/clickhouse.js', () => ({
  ClickHouseDriver: vi.fn().mockImplementation(() => ({ dbType: () => 'clickhouse' })),
}));

import { PgDriver } from '../src/drivers/pg.js';
import { MysqlDriver } from '../src/drivers/mysql.js';
import { ClickHouseDriver } from '../src/drivers/clickhouse.js';
import { createDriver } from '../src/driver-factory.js';
import type { DatabaseCredentials } from '../src/types.js';

const baseCreds: DatabaseCredentials = {
  host: 'localhost',
  port: 5432,
  username: 'user',
  password: 'pass',
  database: 'testdb',
  db_type: 'postgres',
};

describe('createDriver', () => {
  it('should return PgDriver for postgres', () => {
    const driver = createDriver({ ...baseCreds, db_type: 'postgres' });
    expect(PgDriver).toHaveBeenCalled();
    expect(driver.dbType()).toBe('postgres');
  });

  it('should return PgDriver for postgresql', () => {
    const driver = createDriver({ ...baseCreds, db_type: 'postgresql' });
    expect(PgDriver).toHaveBeenCalled();
    expect(driver.dbType()).toBe('postgres');
  });

  it('should return MysqlDriver for mysql', () => {
    const driver = createDriver({ ...baseCreds, db_type: 'mysql', port: 3306 });
    expect(MysqlDriver).toHaveBeenCalled();
    expect(driver.dbType()).toBe('mysql');
  });

  it('should return MysqlDriver for mariadb', () => {
    const driver = createDriver({ ...baseCreds, db_type: 'mariadb', port: 3306 });
    expect(MysqlDriver).toHaveBeenCalled();
    expect(driver.dbType()).toBe('mysql');
  });

  it('should return ClickHouseDriver for clickhouse', () => {
    const driver = createDriver({ ...baseCreds, db_type: 'clickhouse', port: 8123 });
    expect(ClickHouseDriver).toHaveBeenCalled();
    expect(driver.dbType()).toBe('clickhouse');
  });

  it('should throw for unsupported database type', () => {
    expect(() => createDriver({ ...baseCreds, db_type: 'oracle' as never })).toThrow(
      'Unsupported database type: oracle',
    );
  });
});
