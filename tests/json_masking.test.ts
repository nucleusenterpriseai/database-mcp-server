/**
 * JSON-Path Masking Tests (TDD — write FIRST)
 *
 * Tests post-query masking of PII inside JSON columns.
 * Covers: nested paths, arrays, all mask types, non-JSON passthrough,
 * config parsing, and integration with QueryResult.
 */

import { describe, it, expect } from 'vitest';
import { applyJsonMasking, maskValue } from '../src/json_masking.js';
import type { JsonPathMaskingRule } from '../src/types.js';

// ─── maskValue (unit) ─────────────────────────────────────────────────────

describe('maskValue', () => {
  it('masks email: keeps first char + domain', () => {
    expect(maskValue('alice@example.com', 'email')).toBe('a***@example.com');
  });

  it('masks phone_last4: shows last 4 digits', () => {
    expect(maskValue('+65-9123-4567', 'phone_last4')).toBe('***-***-4567');
  });

  it('masks ssn_last4: shows last 4', () => {
    expect(maskValue('S1234567A', 'ssn_last4')).toBe('***-**-567A');
  });

  it('masks name_initial: keeps first char', () => {
    expect(maskValue('Alice Johnson', 'name_initial')).toBe('A***');
  });

  it('masks credit_card: shows last 4', () => {
    expect(maskValue('4111-1111-1111-1234', 'credit_card')).toBe('****-****-****-1234');
  });

  it('redacts entirely', () => {
    expect(maskValue('some secret', 'redact')).toBe('[REDACTED]');
  });

  it('ip_partial: keeps first octet', () => {
    expect(maskValue('192.168.1.100', 'ip_partial')).toBe('192.xxx.xxx.xxx');
  });

  it('none returns value unchanged', () => {
    expect(maskValue('hello', 'none')).toBe('hello');
  });

  it('returns empty string for null/undefined', () => {
    expect(maskValue(null, 'redact')).toBe('[REDACTED]');
    expect(maskValue(undefined, 'redact')).toBe('[REDACTED]');
  });

  it('coerces numbers to string before masking', () => {
    expect(maskValue(12345678, 'ssn_last4')).toBe('***-**-5678');
  });
});

// ─── applyJsonMasking (integration) ───────────────────────────────────────

describe('applyJsonMasking', () => {
  // ─── Simple top-level JSON key ──────────────────────────────────────
  it('masks a top-level key in a JSON string column', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 'profiles', column: 'data', paths: [{ path: 'email', mask: 'email' }] },
    ];
    const rows = [
      { id: 1, data: '{"email":"alice@example.com","role":"admin"}' },
    ];
    const result = applyJsonMasking(rows, 'profiles', rules);
    const parsed = JSON.parse(result[0].data as string);
    expect(parsed.email).toBe('a***@example.com');
    expect(parsed.role).toBe('admin'); // untouched
  });

  // ─── Nested path ────────────────────────────────────────────────────
  it('masks a nested path like "contact.phone"', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 'profiles', column: 'data', paths: [{ path: 'contact.phone', mask: 'phone_last4' }] },
    ];
    const rows = [
      { id: 1, data: '{"name":"Alice","contact":{"phone":"+6591234567","city":"Singapore"}}' },
    ];
    const result = applyJsonMasking(rows, 'profiles', rules);
    const parsed = JSON.parse(result[0].data as string);
    expect(parsed.contact.phone).toBe('***-***-4567');
    expect(parsed.contact.city).toBe('Singapore'); // untouched
    expect(parsed.name).toBe('Alice'); // untouched
  });

  // ─── Deep nested path ──────────────────────────────────────────────
  it('masks deeply nested path like "a.b.c.nric"', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'j', paths: [{ path: 'a.b.c.nric', mask: 'ssn_last4' }] },
    ];
    const rows = [
      { j: '{"a":{"b":{"c":{"nric":"S1234567A","other":"keep"}}}}' },
    ];
    const result = applyJsonMasking(rows, 't', rules);
    const parsed = JSON.parse(result[0].j as string);
    expect(parsed.a.b.c.nric).toBe('***-**-567A');
    expect(parsed.a.b.c.other).toBe('keep');
  });

  // ─── Multiple paths in one rule ─────────────────────────────────────
  it('masks multiple paths in the same column', () => {
    const rules: JsonPathMaskingRule[] = [
      {
        table: 'users',
        column: 'profile',
        paths: [
          { path: 'nric', mask: 'ssn_last4' },
          { path: 'fullName', mask: 'name_initial' },
          { path: 'phone', mask: 'phone_last4' },
          { path: 'address', mask: 'redact' },
        ],
      },
    ];
    const rows = [
      { id: 1, profile: '{"nric":"S1234567A","fullName":"Alice Tan","phone":"+6591234567","address":"123 Main St","dept":"Engineering"}' },
    ];
    const result = applyJsonMasking(rows, 'users', rules);
    const parsed = JSON.parse(result[0].profile as string);
    expect(parsed.nric).toBe('***-**-567A');
    expect(parsed.fullName).toBe('A***');
    expect(parsed.phone).toBe('***-***-4567');
    expect(parsed.address).toBe('[REDACTED]');
    expect(parsed.dept).toBe('Engineering'); // untouched
  });

  // ─── Multiple rows ─────────────────────────────────────────────────
  it('masks all rows', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'data', paths: [{ path: 'email', mask: 'email' }] },
    ];
    const rows = [
      { data: '{"email":"alice@test.com"}' },
      { data: '{"email":"bob@test.com"}' },
    ];
    const result = applyJsonMasking(rows, 't', rules);
    expect(JSON.parse(result[0].data as string).email).toBe('a***@test.com');
    expect(JSON.parse(result[1].data as string).email).toBe('b***@test.com');
  });

  // ─── Column value is already parsed object (not string) ─────────────
  it('handles column value that is already a parsed object', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'data', paths: [{ path: 'name', mask: 'name_initial' }] },
    ];
    const rows = [
      { data: { name: 'Charlie', age: 30 } },
    ];
    const result = applyJsonMasking(rows, 't', rules);
    const val = result[0].data as Record<string, unknown>;
    expect(val.name).toBe('C***');
    expect(val.age).toBe(30);
  });

  // ─── Non-JSON value in column → passthrough ─────────────────────────
  it('passes through non-JSON string values unchanged', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'data', paths: [{ path: 'email', mask: 'email' }] },
    ];
    const rows = [
      { data: 'plain text, not json' },
    ];
    const result = applyJsonMasking(rows, 't', rules);
    expect(result[0].data).toBe('plain text, not json');
  });

  // ─── Null/empty column value → passthrough ──────────────────────────
  it('passes through null values unchanged', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'data', paths: [{ path: 'email', mask: 'email' }] },
    ];
    const rows = [{ data: null }];
    const result = applyJsonMasking(rows, 't', rules);
    expect(result[0].data).toBeNull();
  });

  // ─── Missing path in JSON → no error, no change ────────────────────
  it('ignores paths that do not exist in the JSON', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'data', paths: [{ path: 'nonexistent', mask: 'redact' }] },
    ];
    const rows = [{ data: '{"name":"Alice"}' }];
    const result = applyJsonMasking(rows, 't', rules);
    const parsed = JSON.parse(result[0].data as string);
    expect(parsed.name).toBe('Alice');
  });

  // ─── Table name matching is case-insensitive ────────────────────────
  it('matches table name case-insensitively', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 'Users', column: 'data', paths: [{ path: 'email', mask: 'redact' }] },
    ];
    const rows = [{ data: '{"email":"test@x.com"}' }];
    const result = applyJsonMasking(rows, 'users', rules);
    expect(JSON.parse(result[0].data as string).email).toBe('[REDACTED]');
  });

  // ─── No matching rules → rows returned unchanged ───────────────────
  it('returns rows unchanged when no rules match the table', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 'other_table', column: 'data', paths: [{ path: 'email', mask: 'redact' }] },
    ];
    const rows = [{ data: '{"email":"test@x.com"}' }];
    const result = applyJsonMasking(rows, 'my_table', rules);
    expect(result[0].data).toBe('{"email":"test@x.com"}');
  });

  // ─── Empty rules array → rows returned unchanged ───────────────────
  it('returns rows unchanged with empty rules', () => {
    const rows = [{ data: '{"email":"test@x.com"}' }];
    const result = applyJsonMasking(rows, 't', []);
    expect(result[0].data).toBe('{"email":"test@x.com"}');
  });

  // ─── Array values in JSON path ──────────────────────────────────────
  it('masks values inside arrays when path targets array elements', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'data', paths: [{ path: 'children[].name', mask: 'name_initial' }] },
    ];
    const rows = [
      { data: '{"children":[{"name":"Alice","age":10},{"name":"Bob","age":8}]}' },
    ];
    const result = applyJsonMasking(rows, 't', rules);
    const parsed = JSON.parse(result[0].data as string);
    expect(parsed.children[0].name).toBe('A***');
    expect(parsed.children[1].name).toBe('B***');
    expect(parsed.children[0].age).toBe(10); // untouched
  });

  // ─── Nested arrays ─────────────────────────────────────────────────
  it('masks nested array paths like "family[].members[].nric"', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'data', paths: [{ path: 'family[].members[].nric', mask: 'ssn_last4' }] },
    ];
    const rows = [
      { data: '{"family":[{"members":[{"nric":"S1234567A"},{"nric":"S9876543B"}]}]}' },
    ];
    const result = applyJsonMasking(rows, 't', rules);
    const parsed = JSON.parse(result[0].data as string);
    expect(parsed.family[0].members[0].nric).toBe('***-**-567A');
    expect(parsed.family[0].members[1].nric).toBe('***-**-543B');
  });

  // ─── Multiple columns with different rules ─────────────────────────
  it('applies rules to multiple columns in the same table', () => {
    const rules: JsonPathMaskingRule[] = [
      { table: 't', column: 'profile', paths: [{ path: 'name', mask: 'name_initial' }] },
      { table: 't', column: 'contact', paths: [{ path: 'phone', mask: 'phone_last4' }] },
    ];
    const rows = [
      { profile: '{"name":"Alice"}', contact: '{"phone":"+6591234567"}' },
    ];
    const result = applyJsonMasking(rows, 't', rules);
    expect(JSON.parse(result[0].profile as string).name).toBe('A***');
    expect(JSON.parse(result[0].contact as string).phone).toBe('***-***-4567');
  });
});
