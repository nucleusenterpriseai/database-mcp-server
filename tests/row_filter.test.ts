/**
 * Row Filter Injection Tests (TDD — write FIRST)
 */

import { describe, it, expect } from 'vitest';
import { applyRowFilters } from '../src/row_filter.js';
import type { RowFilter } from '../src/types.js';

describe('applyRowFilters', () => {
  // ─── No filters → unchanged ────────────────────────────────────────
  it('returns query unchanged when no filters', () => {
    const result = applyRowFilters('SELECT * FROM users', 'postgresql', []);
    expect(result.toLowerCase()).toContain('select');
    expect(result.toLowerCase()).toContain('users');
  });

  // ─── No WHERE → adds WHERE ─────────────────────────────────────────
  it('adds WHERE clause when none exists', () => {
    const filters: RowFilter[] = [{ table: 'users', condition: "department = 'engineering'" }];
    const result = applyRowFilters('SELECT name FROM users', 'postgresql', filters);
    expect(result.toLowerCase()).toContain('where');
    expect(result).toContain("department = 'engineering'");
  });

  // ─── Existing WHERE → AND conjunction ──────────────────────────────
  it('adds AND to existing WHERE clause', () => {
    const filters: RowFilter[] = [{ table: 'users', condition: "department = 'engineering'" }];
    const result = applyRowFilters(
      "SELECT name FROM users WHERE active = true",
      'postgresql',
      filters,
    );
    expect(result.toLowerCase()).toContain('where');
    expect(result).toContain("department = 'engineering'");
    // Both conditions should be present
    expect(result.toLowerCase()).toContain('active');
  });

  // ─── JOIN with filter on one table ──────────────────────────────────
  it('applies filter only to matching table in JOIN', () => {
    const filters: RowFilter[] = [{ table: 'users', condition: "role = 'admin'" }];
    const result = applyRowFilters(
      'SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id',
      'postgresql',
      filters,
    );
    expect(result).toContain("role = 'admin'");
  });

  // ─── Multiple filters on same table → AND ──────────────────────────
  it('combines multiple filters for same table with AND', () => {
    const filters: RowFilter[] = [
      { table: 'users', condition: "department = 'engineering'" },
      { table: 'users', condition: 'active = true' },
    ];
    const result = applyRowFilters('SELECT name FROM users', 'postgresql', filters);
    expect(result).toContain("department = 'engineering'");
    expect(result.toLowerCase()).toContain('active = true');
  });

  // ─── No matching filter table → unchanged ──────────────────────────
  it('returns query unchanged when no filter matches any table', () => {
    const filters: RowFilter[] = [{ table: 'projects', condition: "status = 'open'" }];
    const result = applyRowFilters('SELECT * FROM users', 'postgresql', filters);
    expect(result.toLowerCase()).not.toContain('status');
  });

  // ─── Table alias handled correctly ──────────────────────────────────
  it('applies filter when table has alias', () => {
    const filters: RowFilter[] = [{ table: 'users', condition: "role = 'admin'" }];
    const result = applyRowFilters(
      'SELECT u.name FROM users u',
      'postgresql',
      filters,
    );
    expect(result).toContain("role = 'admin'");
  });

  // ─── ORDER BY preserved ────────────────────────────────────────────
  it('preserves ORDER BY after filter injection', () => {
    const filters: RowFilter[] = [{ table: 'users', condition: "department = 'engineering'" }];
    const result = applyRowFilters(
      'SELECT name FROM users ORDER BY name',
      'postgresql',
      filters,
    );
    expect(result).toContain("department = 'engineering'");
    expect(result.toUpperCase()).toContain('ORDER BY');
  });
});
