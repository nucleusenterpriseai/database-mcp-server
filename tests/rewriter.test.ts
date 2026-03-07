/**
 * Integrated Query Rewriting Pipeline Tests (TDD — write FIRST)
 */

import { describe, it, expect } from 'vitest';
import { QueryRewriter } from '../src/rewriter.js';
import type { MaskingRule, RowFilter, SchemaCache } from '../src/types.js';

const schemaCache: SchemaCache = {
  tables: {
    users: {
      columns: [
        { name: 'id', type: 'integer', nullable: false, default_value: null, is_primary_key: true },
        { name: 'email', type: 'varchar', nullable: false, default_value: null, is_primary_key: false },
        { name: 'name', type: 'varchar', nullable: false, default_value: null, is_primary_key: false },
        { name: 'department', type: 'varchar', nullable: false, default_value: null, is_primary_key: false },
      ],
    },
    orders: {
      columns: [
        { name: 'id', type: 'integer', nullable: false, default_value: null, is_primary_key: true },
        { name: 'user_id', type: 'integer', nullable: false, default_value: null, is_primary_key: false },
        { name: 'total', type: 'numeric', nullable: false, default_value: null, is_primary_key: false },
      ],
    },
  },
};

describe('QueryRewriter', () => {
  // ─── Full pipeline: masking + row filter + LIMIT ───────────────────
  it('applies masking, row filter, and LIMIT in one query', () => {
    const rewriter = new QueryRewriter(
      'postgresql',
      [{ table: 'users', column: 'email', type: 'redact' }],
      [{ table: 'users', condition: "department = 'engineering'" }],
      ['users'],
      schemaCache,
      1000,
    );

    const result = rewriter.rewrite('SELECT id, email FROM users');
    expect('error' in result).toBe(false);
    if ('rewritten' in result) {
      expect(result.rewritten).toContain('REDACTED');
      expect(result.rewritten).toContain("department = 'engineering'");
      expect(result.rewritten.toUpperCase()).toContain('LIMIT');
    }
  });

  // ─── Rejected queries return error ─────────────────────────────────
  it('rejects DDL with QUERY_BLOCKED_DESTRUCTIVE', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], ['users'], schemaCache);
    const result = rewriter.rewrite('DROP TABLE users');
    expect(result).toEqual({
      error: 'Destructive operations (DROP, ALTER, TRUNCATE) are not allowed.',
    });
  });

  it('rejects multi-statement with QUERY_BLOCKED_MULTI', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], ['users'], schemaCache);
    const result = rewriter.rewrite('SELECT 1; DROP TABLE users');
    expect(result).toEqual({
      error: 'Multi-statement queries are not allowed. Please send one query at a time.',
    });
  });

  it('rejects write operations with QUERY_BLOCKED_WRITE', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], ['users'], schemaCache);
    const result = rewriter.rewrite("INSERT INTO users VALUES (1, 'a', 'b', 'c')");
    expect(result).toEqual({
      error: 'Write operations (INSERT, UPDATE, DELETE) are not allowed. Only SELECT queries are permitted.',
    });
  });

  it('rejects session manipulation with QUERY_BLOCKED_SESSION', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], ['users'], schemaCache);
    const result = rewriter.rewrite('SET statement_timeout = 0');
    expect(result).toEqual({
      error: 'Session manipulation (SET, COMMIT, ROLLBACK) is not allowed.',
    });
  });

  // ─── Table not allowed → TABLE_NOT_ALLOWED ─────────────────────────
  it('rejects query referencing unauthorized table', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], ['users'], schemaCache);
    const result = rewriter.rewrite('SELECT * FROM secrets');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('secrets');
      expect(result.error).toContain('not in the allowed tables');
    }
  });

  // ─── Empty masking + empty filters → only LIMIT ────────────────────
  it('only adds LIMIT when no masking or filters', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], ['users'], schemaCache);
    const result = rewriter.rewrite('SELECT id, name FROM users');
    expect('rewritten' in result).toBe(true);
    if ('rewritten' in result) {
      expect(result.rewritten.toUpperCase()).toContain('LIMIT');
      expect(result.rewritten).not.toContain('REDACTED');
    }
  });

  // ─── Empty allowed_tables means no restriction ─────────────────────
  it('allows any table when allowed_tables is empty', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], [], schemaCache);
    const result = rewriter.rewrite('SELECT * FROM any_table');
    expect('rewritten' in result).toBe(true);
  });

  // ─── Parse error ───────────────────────────────────────────────────
  it('returns PARSE_ERROR for invalid SQL', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], ['users'], schemaCache);
    const result = rewriter.rewrite('SLECT * FORM users');
    expect(result).toEqual({
      error: 'Could not parse the SQL query. Please check the syntax and try again.',
    });
  });

  // ─── Each error code matches format ────────────────────────────────
  it('dangerous function returns correct error', () => {
    const rewriter = new QueryRewriter('postgresql', [], [], ['users'], schemaCache);
    const result = rewriter.rewrite("SELECT pg_read_file('/etc/passwd')");
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('blocked');
    }
  });
});
