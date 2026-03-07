/**
 * Shared dialect mapping for node-sql-parser.
 */

/**
 * Map our dialect strings to node-sql-parser database names.
 */
export function mapDialect(dialect: string): string {
  const d = dialect.toLowerCase();
  if (d === 'postgresql' || d === 'postgres') return 'PostgresQL';
  if (d === 'mysql' || d === 'mariadb') return 'MySQL';
  return 'PostgresQL';
}
