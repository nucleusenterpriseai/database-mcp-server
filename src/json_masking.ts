/**
 * JSON-Path Post-Query Masking
 *
 * Masks PII fields inside JSON columns after query execution.
 * Works with any database — operates on result rows in memory.
 *
 * Supports:
 *   - Top-level keys: "email"
 *   - Nested paths:   "contact.phone"
 *   - Array traversal: "children[].name", "family[].members[].nric"
 *   - All existing mask types: email, phone_last4, ssn_last4, etc.
 */

import type { JsonPathMaskingRule, MaskingType } from './types.js';

/**
 * Apply a mask to a single string value.
 * Reuses the same mask logic as SQL column masking, but in-memory.
 */
export function maskValue(value: unknown, type: MaskingType): string {
  if (type === 'none') {
    return String(value ?? '');
  }
  if (type === 'redact') {
    return '[REDACTED]';
  }

  const str = String(value ?? '');
  if (str.length === 0) return str;

  switch (type) {
    case 'email': {
      const atIdx = str.indexOf('@');
      if (atIdx <= 0) return `${str[0]}***`;
      return `${str[0]}***@${str.slice(atIdx + 1)}`;
    }
    case 'phone_last4':
      return `***-***-${str.slice(-4)}`;
    case 'ssn_last4':
      return `***-**-${str.slice(-4)}`;
    case 'credit_card':
      return `****-****-****-${str.slice(-4)}`;
    case 'name_initial':
      return `${str[0]}***`;
    case 'ip_partial': {
      const dotIdx = str.indexOf('.');
      if (dotIdx < 0) return str;
      return `${str.slice(0, dotIdx)}.xxx.xxx.xxx`;
    }
    default:
      return str;
  }
}

/**
 * Traverse a parsed JSON object and mask values at specified paths.
 *
 * Path syntax:
 *   "key"           → obj.key
 *   "a.b.c"         → obj.a.b.c
 *   "items[].name"  → obj.items[0].name, obj.items[1].name, ...
 */
function maskAtPath(obj: unknown, pathParts: string[], mask: MaskingType): void {
  if (obj == null || typeof obj !== 'object') return;
  if (pathParts.length === 0) return;

  const [head, ...rest] = pathParts;

  // Array traversal: "items[]" means iterate over array at "items"
  if (head.endsWith('[]')) {
    const key = head.slice(0, -2);
    const container = (obj as Record<string, unknown>)[key];
    if (!Array.isArray(container)) return;
    for (const item of container) {
      if (rest.length === 0) continue; // can't mask the array itself
      maskAtPath(item, rest, mask);
    }
    return;
  }

  const record = obj as Record<string, unknown>;

  // Terminal: this is the leaf key to mask
  if (rest.length === 0) {
    if (head in record) {
      record[head] = maskValue(record[head], mask);
    }
    return;
  }

  // Recurse into nested object
  if (record[head] != null && typeof record[head] === 'object') {
    maskAtPath(record[head], rest, mask);
  }
}

/**
 * Apply JSON-path masking rules to query result rows.
 *
 * For each row, finds columns that have JSON-path rules for the given table,
 * parses the JSON (if string), applies masks at each specified path, and
 * serializes back to string (or returns modified object if it was already parsed).
 *
 * Non-JSON values, null values, and missing paths are left unchanged.
 */
export function applyJsonMasking(
  rows: Record<string, unknown>[],
  tableName: string,
  rules: JsonPathMaskingRule[],
): Record<string, unknown>[] {
  if (rules.length === 0 || rows.length === 0) return rows;

  // Filter rules for this table
  const tableRules = rules.filter(
    (r) => r.table.toLowerCase() === tableName.toLowerCase(),
  );
  if (tableRules.length === 0) return rows;

  // Build column → paths map
  const columnRules = new Map<string, JsonPathMaskingRule>();
  for (const rule of tableRules) {
    columnRules.set(rule.column.toLowerCase(), rule);
  }

  for (const row of rows) {
    for (const [colKey, rule] of columnRules) {
      // Find the actual column key in the row (case-insensitive match)
      const actualKey = Object.keys(row).find(
        (k) => k.toLowerCase() === colKey,
      );
      if (!actualKey) continue;

      const value = row[actualKey];
      if (value == null) continue;

      // Parse JSON if string, or use directly if already an object
      let parsed: unknown;
      let wasString = false;

      if (typeof value === 'string') {
        try {
          parsed = JSON.parse(value);
        } catch {
          continue; // not valid JSON — skip
        }
        wasString = true;
      } else if (typeof value === 'object') {
        // Deep clone to avoid mutating original (shallow is fine for our use)
        parsed = JSON.parse(JSON.stringify(value));
      } else {
        continue;
      }

      // Apply each path mask
      for (const pathMask of rule.paths) {
        const parts = pathMask.path.split('.');
        maskAtPath(parsed, parts, pathMask.mask);
      }

      // Write back
      row[actualKey] = wasString ? JSON.stringify(parsed) : parsed;
    }
  }

  return rows;
}
