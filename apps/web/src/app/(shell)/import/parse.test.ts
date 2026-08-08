/**
 * The same four cases this screen was built against, now run through
 * `@hishab/core` instead of a second copy of the logic. It exists to prove the
 * swap changed no behaviour, so an expectation here is not to be "adjusted" to
 * match a new answer — a failure means the two implementations disagreed, and
 * that is the bug the swap was for.
 */

import { guessMapping, parseDateFlexible, parseDelimited } from '@hishab/core';
import { describe, expect, it } from 'vitest';
import { buildPreview, mappingFromRoles, rolesFromMapping, toCommitRows } from './parse';

const FILE = [
  'Txn Date,Particulars,Debit,Credit,Balance',
  '03/04/2026,"BKASH, ৳ payment",1234.29,,10000.00',
  '31/03/2026,Salary,,"50,000.00",11234.29',
  '31/03/2026,Salary,,"50,000.00",11234.29',
  'oops,Broken row,abc,,0',
].join('\n');

const NO_DUPLICATES: ReadonlySet<string> = new Set();

describe('import parsing, via @hishab/core', () => {
  it('reads quoted cells and skips blank lines', () => {
    const grid = parseDelimited(FILE);
    expect(grid).toHaveLength(5);
    expect(grid[1]?.[1]).toBe('BKASH, ৳ payment');
  });

  it('honours the stated date order and never guesses', () => {
    expect(parseDateFlexible('03/04/2026', 'DMY')).toBe('2026-04-03');
    expect(parseDateFlexible('03/04/2026', 'MDY')).toBe('2026-03-04');
    expect(parseDateFlexible('2026-04-03', 'MDY')).toBe('2026-04-03');
    expect(parseDateFlexible('31/02/2026', 'DMY')).toBeNull();
  });

  it('resolves debit and credit into signed poisha without float error', () => {
    const grid = parseDelimited(FILE);
    const headers = (grid[0] ?? []).map((h) => h.trim());
    const roles = rolesFromMapping(guessMapping(headers), headers);
    const built = buildPreview(grid, mappingFromRoles(roles, headers), 'DMY', NO_DUPLICATES);

    expect(roles).toEqual(['date', 'description', 'debit', 'credit', 'balance']);

    // 1234.29 must be 123429 poisha. Number(x) * 100 gives 123428.99999999999.
    expect(built.display[0]?.amountMinor).toBe(-123429);
    expect(built.display[1]?.amountMinor).toBe(5000000);
    expect(built.display[3]?.problem).toContain('তারিখ');

    expect(built.counts).toEqual({ importable: 3, duplicates: 0, broken: 1 });
    expect(toCommitRows(built.rows).map((r) => r.direction)).toEqual(['OUT', 'IN', 'IN']);
  });

  it('flags only the rows the server says are already in the books', () => {
    const grid = parseDelimited(FILE);
    const headers = (grid[0] ?? []).map((h) => h.trim());
    const mapping = mappingFromRoles(rolesFromMapping(guessMapping(headers), headers), headers);

    const clean = buildPreview(grid, mapping, 'DMY', NO_DUPLICATES);
    const known = new Set([clean.rows[1]!.dedupeKey]);
    const marked = buildPreview(grid, mapping, 'DMY', known);

    expect(marked.rows.map((r) => r.isDuplicate)).toEqual([false, true, false]);
    expect(marked.counts).toEqual({ importable: 2, duplicates: 1, broken: 1 });
  });

  it("round-trips core's ColumnMapping through the dropdowns unchanged", () => {
    const headers = ['Txn Date', 'Note', 'Value'];
    const roles = rolesFromMapping(
      {
        date: { index: 0, header: 'Txn Date', confidence: 100 },
        amount: { index: 2, header: 'Value', confidence: 90 },
      },
      headers,
    );
    expect(roles).toEqual(['date', 'ignore', 'amount']);
    expect(mappingFromRoles(roles, headers).amount?.index).toBe(2);
  });
});
