/**
 * The same cases this screen was built against, run through `@hishab/core`
 * rather than a second copy of the logic. It exists to prove the swap changed
 * no behaviour, so an expectation here is not to be "adjusted" to match a new
 * answer — a failure means the two implementations disagreed, and that is the
 * bug the swap was for.
 *
 * Building the rows a person then approves is `review.test.ts`.
 */

import { parseDateFlexible, parseDelimited } from '@hishab/core';
import { describe, expect, it } from 'vitest';
import { mappingFromRoles, mappingProblems, rolesFromMapping } from './parse';

const FILE = [
  'Txn Date,Particulars,Debit,Credit,Balance',
  '03/04/2026,"BKASH, ৳ payment",1234.29,,10000.00',
  '31/03/2026,Salary,,"50,000.00",11234.29',
  'oops,Broken row,abc,,0',
].join('\n');

describe('import parsing, via @hishab/core', () => {
  it('reads quoted cells and skips blank lines', () => {
    const grid = parseDelimited(FILE);
    expect(grid).toHaveLength(4);
    expect(grid[1]?.[1]).toBe('BKASH, ৳ payment');
  });

  it('honours the stated date order and never guesses', () => {
    expect(parseDateFlexible('03/04/2026', 'DMY')).toBe('2026-04-03');
    expect(parseDateFlexible('03/04/2026', 'MDY')).toBe('2026-03-04');
    expect(parseDateFlexible('2026-04-03', 'MDY')).toBe('2026-04-03');
    expect(parseDateFlexible('31/02/2026', 'DMY')).toBeNull();
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

  it('says what is wrong with a mapping once, not once per row', () => {
    const { blocking } = mappingProblems(['ignore', 'description'], {
      description: { index: 1, header: 'Note', confidence: 100 },
    });
    expect(blocking).toHaveLength(2);
  });
});
