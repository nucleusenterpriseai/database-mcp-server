/**
 * ClickHouse HTTPS Fix Tests (Task 1.1)
 *
 * Verifies that ClickHouse driver respects ssl_mode for protocol selection.
 * Bug: Line 27 hardcodes `http://` — should use `https://` when ssl_mode != 'disable'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseCredentials } from '../../src/types.js';

// vi.mock is hoisted — factory must not reference outer variables
vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn().mockReturnValue({
    query: vi.fn(),
    close: vi.fn(),
  }),
}));

// Import after mock
import { createClient } from '@clickhouse/client';
import { ClickHouseDriver } from '../../src/drivers/clickhouse.js';

describe('ClickHouse HTTPS fix', () => {
  const baseCredentials: DatabaseCredentials = {
    host: 'ch.example.com',
    port: 8443,
    username: 'default',
    password: 'secret',
    database: 'analytics',
    db_type: 'clickhouse',
  };

  beforeEach(() => {
    vi.mocked(createClient).mockClear();
  });

  it('should use http:// when ssl_mode is "disable"', () => {
    new ClickHouseDriver({ ...baseCredentials, ssl_mode: 'disable' });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://ch.example.com:8443',
      }),
    );
  });

  it('should use https:// when ssl_mode is "require"', () => {
    new ClickHouseDriver({ ...baseCredentials, ssl_mode: 'require' });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://ch.example.com:8443',
      }),
    );
  });

  it('should use https:// when ssl_mode is undefined (secure by default)', () => {
    const { ssl_mode, ...credsNoSsl } = baseCredentials;
    new ClickHouseDriver(credsNoSsl as DatabaseCredentials);

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://ch.example.com:8443',
      }),
    );
  });

  it('should use https:// when ssl_mode is "verify-full"', () => {
    new ClickHouseDriver({ ...baseCredentials, ssl_mode: 'verify-full' });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://ch.example.com:8443',
      }),
    );
  });
});
