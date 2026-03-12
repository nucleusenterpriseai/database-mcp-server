/**
 * Column Masking via Query Rewriting Tests (TDD — write FIRST)
 */

import { describe, it, expect } from 'vitest';
import { applyMasking } from '../src/masking.js';
import type { MaskingRule, SchemaCache } from '../src/types.js';

const schemaCache: SchemaCache = {
  tables: {
    users: {
      columns: [
        { name: 'id', type: 'integer', nullable: false, default_value: null, is_primary_key: true },
        { name: 'email', type: 'varchar', nullable: false, default_value: null, is_primary_key: false },
        { name: 'phone', type: 'varchar', nullable: true, default_value: null, is_primary_key: false },
        { name: 'name', type: 'varchar', nullable: false, default_value: null, is_primary_key: false },
        { name: 'ssn', type: 'varchar', nullable: true, default_value: null, is_primary_key: false },
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

describe('applyMasking', () => {
  // ─── No masking rules → unchanged ─────────────────────────────────
  it('returns query unchanged when no masking rules', () => {
    const result = applyMasking('SELECT id, email FROM users', 'postgresql', [], schemaCache);
    expect(result).toContain('id');
    expect(result).toContain('email');
  });

  // ─── Simple SELECT with one masked column ─────────────────────────
  it('masks a single column in explicit SELECT', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'email' }];
    const result = applyMasking('SELECT id, email FROM users', 'postgresql', rules, schemaCache);
    // Should contain masking expression, not bare "email" in projection
    expect(result.toUpperCase()).toContain('CONCAT');
    expect(result).toContain('id');
  });

  // ─── SELECT * expansion + masking ──────────────────────────────────
  it('expands SELECT * and applies masking', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'redact' }];
    const result = applyMasking('SELECT * FROM users', 'postgresql', rules, schemaCache);
    expect(result).toContain('REDACTED');
    expect(result).toContain('id');
  });

  // ─── Column not in masking rules → passed through ──────────────────
  it('passes through columns not in masking rules', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'redact' }];
    const result = applyMasking('SELECT id, name, email FROM users', 'postgresql', rules, schemaCache);
    expect(result).toContain('REDACTED');
    // id and name should appear unmasked
    expect(result).toContain('id');
    expect(result).toContain('name');
  });

  // ─── All masking types (PostgreSQL) ────────────────────────────────
  it('email masking produces correct PG expression', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'email' }];
    const result = applyMasking('SELECT email FROM users', 'postgresql', rules, schemaCache);
    expect(result.toUpperCase()).toContain('CONCAT');
    expect(result).toContain('***@');
  });

  it('phone_last4 masking produces correct PG expression', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'phone', type: 'phone_last4' }];
    const result = applyMasking('SELECT phone FROM users', 'postgresql', rules, schemaCache);
    expect(result).toContain('***-***-');
  });

  it('redact masking produces [REDACTED]', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'ssn', type: 'redact' }];
    const result = applyMasking('SELECT ssn FROM users', 'postgresql', rules, schemaCache);
    expect(result).toContain('REDACTED');
  });

  it('none masking type passes column through', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'none' }];
    const result = applyMasking('SELECT email FROM users', 'postgresql', rules, schemaCache);
    // Should contain email without masking expression
    expect(result.toUpperCase()).not.toContain('CONCAT');
  });

  // ─── ClickHouse dialect ──────────────────────────────────────────
  it('email masking uses splitByChar for ClickHouse', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'email' }];
    const result = applyMasking('SELECT email FROM users', 'clickhouse', rules, schemaCache);
    expect(result).toContain('splitByChar');
    expect(result).toContain('arrayElement');
    expect(result.toUpperCase()).not.toContain('SPLIT_PART');
    expect(result.toUpperCase()).not.toContain('SUBSTRING_INDEX');
  });

  it('ip_partial masking uses splitByChar for ClickHouse', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'name', type: 'ip_partial' }];
    const result = applyMasking('SELECT name FROM users', 'clickhouse', rules, schemaCache);
    expect(result).toContain('splitByChar');
    expect(result).toContain('arrayElement');
    expect(result.toUpperCase()).not.toContain('SPLIT_PART');
  });

  // ─── MySQL dialect ─────────────────────────────────────────────────
  it('email masking uses SUBSTRING_INDEX for MySQL', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'email' }];
    const result = applyMasking('SELECT email FROM users', 'mysql', rules, schemaCache);
    expect(result.toUpperCase()).toContain('SUBSTRING_INDEX');
  });

  // ─── MySQL masking types ────────────────────────────────────────────
  it('phone_last4 masking for MySQL', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'phone', type: 'phone_last4' }];
    const result = applyMasking('SELECT phone FROM users', 'mysql', rules, schemaCache);
    expect(result).toContain('***-***-');
  });

  it('ssn_last4 masking for MySQL', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'ssn', type: 'ssn_last4' }];
    const result = applyMasking('SELECT ssn FROM users', 'mysql', rules, schemaCache);
    expect(result).toContain('***-**-');
  });

  it('credit_card masking for MySQL', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'ssn', type: 'credit_card' }];
    const result = applyMasking('SELECT ssn FROM users', 'mysql', rules, schemaCache);
    expect(result).toContain('****-****-****-');
  });

  it('name_initial masking for MySQL', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'name', type: 'name_initial' }];
    const result = applyMasking('SELECT name FROM users', 'mysql', rules, schemaCache);
    expect(result.toUpperCase()).toContain('CONCAT');
    expect(result).toContain('***');
  });

  it('ip_partial masking for MySQL uses SUBSTRING_INDEX', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'name', type: 'ip_partial' }];
    const result = applyMasking('SELECT name FROM users', 'mysql', rules, schemaCache);
    expect(result.toUpperCase()).toContain('SUBSTRING_INDEX');
    expect(result).toContain('.xxx.xxx.xxx');
  });

  it('redact masking for MySQL', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'ssn', type: 'redact' }];
    const result = applyMasking('SELECT ssn FROM users', 'mysql', rules, schemaCache);
    expect(result).toContain('REDACTED');
  });

  it('none masking type for MySQL passes through', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'none' }];
    const result = applyMasking('SELECT email FROM users', 'mysql', rules, schemaCache);
    expect(result.toUpperCase()).not.toContain('CONCAT');
  });

  // ─── JOIN masking ──────────────────────────────────────────────────
  it('applies masking to column in JOIN query', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'redact' }];
    const result = applyMasking(
      'SELECT u.email, o.total FROM users u JOIN orders o ON u.id = o.user_id',
      'postgresql',
      rules,
      schemaCache,
    );
    expect(result).toContain('REDACTED');
  });

  // ─── Subquery masking ──────────────────────────────────────────────
  it('applies masking in outer SELECT with subquery', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'redact' }];
    const result = applyMasking(
      'SELECT email FROM users WHERE id IN (SELECT user_id FROM orders)',
      'postgresql',
      rules,
      schemaCache,
    );
    expect(result).toContain('REDACTED');
  });

  // ─── Column alias preserved ────────────────────────────────────────
  it('preserves column alias after masking', () => {
    const rules: MaskingRule[] = [{ table: 'users', column: 'email', type: 'redact' }];
    const result = applyMasking('SELECT email AS user_email FROM users', 'postgresql', rules, schemaCache);
    expect(result).toContain('REDACTED');
    expect(result.toLowerCase()).toContain('user_email');
  });
});
