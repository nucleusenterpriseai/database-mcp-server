/**
 * Driver Factory
 *
 * Creates the appropriate DatabaseDriver instance based on db_type.
 */

import { PgDriver } from './drivers/pg.js';
import { MysqlDriver } from './drivers/mysql.js';
import { ClickHouseDriver } from './drivers/clickhouse.js';
import type { DatabaseCredentials, DatabaseDriver } from './types.js';

export function createDriver(credentials: DatabaseCredentials): DatabaseDriver {
  switch (credentials.db_type) {
    case 'postgres':
    case 'postgresql':
      return new PgDriver(credentials);
    case 'mysql':
    case 'mariadb':
      return new MysqlDriver(credentials);
    case 'clickhouse':
      return new ClickHouseDriver(credentials);
    default:
      throw new Error(`Unsupported database type: ${credentials.db_type}`);
  }
}
