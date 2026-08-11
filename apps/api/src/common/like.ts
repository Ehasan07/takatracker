/**
 * Escape the LIKE metacharacters before a token reaches Prisma's `contains`.
 *
 * Prisma interpolates `contains` straight into `ILIKE '%' || $1 || '%'`, so an
 * unescaped `%` is a wildcard: searching `50%` would return the whole ledger and
 * `_` would match any single character. Postgres's default LIKE escape is the
 * backslash and the Prisma filter exposes no ESCAPE clause, so prefixing the
 * three metacharacters is both necessary and sufficient.
 *
 * One copy, shared. The ledger search and the mailbox search each had their own
 * — four characters of regex, but two places to get a search-injection rule
 * right and only one of them would be found by anybody fixing it.
 */
export function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, '\\$&');
}
