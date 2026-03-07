/**
 * SQL Safety Module Tests (TDD — write FIRST)
 *
 * Tests for query classification and LIMIT enforcement.
 * Refactored from inline db_query.ts logic into standalone safety.ts.
 */

import { describe, it, expect } from 'vitest';
import { classifyQuery, enforceLimit, type QuerySafety } from '../src/safety.js';

describe('classifyQuery', () => {
  // ─── Safe statements ──────────────────────────────────────────────
  it('SELECT → safe', () => {
    expect(classifyQuery('SELECT * FROM users', 'postgresql')).toBe('safe');
  });

  it('SHOW TABLES → safe', () => {
    expect(classifyQuery('SHOW TABLES', 'mysql')).toBe('safe');
  });

  it('EXPLAIN → safe', () => {
    expect(classifyQuery('EXPLAIN SELECT * FROM users', 'postgresql')).toBe('safe');
  });

  // ─── Write statements ─────────────────────────────────────────────
  it('INSERT → write', () => {
    expect(classifyQuery("INSERT INTO users VALUES (1, 'a')", 'postgresql')).toBe('write');
  });

  it('UPDATE → write', () => {
    expect(classifyQuery("UPDATE users SET name = 'b' WHERE id = 1", 'postgresql')).toBe('write');
  });

  it('DELETE → write', () => {
    expect(classifyQuery('DELETE FROM users WHERE id = 1', 'postgresql')).toBe('write');
  });

  // ─── Destructive statements ────────────────────────────────────────
  it('DROP TABLE → destructive', () => {
    expect(classifyQuery('DROP TABLE users', 'postgresql')).toBe('destructive');
  });

  it('ALTER TABLE → destructive', () => {
    expect(classifyQuery('ALTER TABLE users ADD COLUMN age INT', 'postgresql')).toBe('destructive');
  });

  it('TRUNCATE → destructive', () => {
    expect(classifyQuery('TRUNCATE TABLE users', 'postgresql')).toBe('destructive');
  });

  it('CREATE TABLE → destructive', () => {
    expect(classifyQuery('CREATE TABLE evil (id INT)', 'postgresql')).toBe('destructive');
  });

  // ─── Blocked ───────────────────────────────────────────────────────
  it('multi-statement → blocked', () => {
    const result = classifyQuery('SELECT 1; DROP TABLE users', 'postgresql');
    expect(result).toEqual({ blocked: 'multi-statement' });
  });

  it('SET → blocked session manipulation', () => {
    const result = classifyQuery('SET statement_timeout = 0', 'postgresql');
    expect(result).toEqual({ blocked: 'session manipulation' });
  });

  it('COMMIT → blocked session manipulation', () => {
    const result = classifyQuery('COMMIT', 'postgresql');
    // node-sql-parser classifies COMMIT/ROLLBACK as "transaction" type
    expect(result).toEqual({ blocked: 'session manipulation' });
  });

  it('ROLLBACK → blocked session manipulation', () => {
    const result = classifyQuery('ROLLBACK', 'postgresql');
    expect(result).toEqual({ blocked: 'session manipulation' });
  });

  it('empty SQL → blocked parse error', () => {
    const result = classifyQuery('', 'postgresql');
    expect(result).toEqual({ blocked: 'empty query' });
  });

  it('invalid SQL → blocked parse error', () => {
    const result = classifyQuery('SLECT * FORM users', 'postgresql');
    expect(result).toEqual({ blocked: 'parse error' });
  });

  // ─── Dangerous functions ───────────────────────────────────────────
  it('pg_read_file → blocked dangerous function', () => {
    const result = classifyQuery("SELECT pg_read_file('/etc/passwd')", 'postgresql');
    expect(result).toEqual({ blocked: 'dangerous function: pg_read_file' });
  });

  it('dblink → blocked dangerous function', () => {
    const result = classifyQuery("SELECT dblink('host=evil.com', 'SELECT 1')", 'postgresql');
    expect(result).toEqual({ blocked: 'dangerous function: dblink' });
  });
});

describe('enforceLimit', () => {
  it('adds LIMIT 1000 when missing', () => {
    const result = enforceLimit('SELECT * FROM users', 'postgresql', 1000);
    expect(result.toUpperCase()).toContain('LIMIT');
    expect(result).toContain('1000');
  });

  it('keeps existing LIMIT if <= maxRows', () => {
    const result = enforceLimit('SELECT * FROM users LIMIT 50', 'postgresql', 1000);
    expect(result).toContain('50');
  });

  it('reduces LIMIT to maxRows if exceeds', () => {
    const result = enforceLimit('SELECT * FROM users LIMIT 5000', 'postgresql', 1000);
    expect(result).not.toContain('5000');
    expect(result).toContain('1000');
  });

  it('preserves LIMIT 0', () => {
    const result = enforceLimit('SELECT * FROM users LIMIT 0', 'postgresql', 1000);
    expect(result).toContain('0');
  });

  it('returns non-SELECT statements unchanged', () => {
    const sql = 'SHOW TABLES';
    const result = enforceLimit(sql, 'mysql', 1000);
    expect(result).toBe(sql);
  });
});
