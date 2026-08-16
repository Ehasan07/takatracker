/**
 * The rules of the row-by-row review, tested where they live.
 *
 * Two of these are the safety properties of the whole feature and are worth
 * failing loudly over:
 *
 *  - a row that might already be in the books does **not** start ticked, so
 *    the default action on an ambiguous row is never to double it;
 *  - `acceptDuplicate` is sent only on a row that actually carried a warning,
 *    so it can never quietly become a switch that turns the server's own
 *    duplicate check off for a whole file.
 */

import { guessMapping, parseDelimited } from '@hishab/core';
import { describe, expect, it } from 'vitest';
import type { CategoryDto } from '@/lib/api';
import { mappingFromRoles, rolesFromMapping } from './parse';
import { approvedByDefault, buildReview, probesFrom, toApprovedRows } from './review';
import type { DuplicateReport } from './statement-types';

const FILE = [
  'Txn Date,Particulars,Debit,Credit,Category',
  '03/04/2026,"BKASH, ৳ payment",1234.29,,বাজার',
  '31/03/2026,Salary,,"50,000.00",',
  'oops,Broken row,abc,,',
].join('\n');

const GRID = parseDelimited(FILE);
const HEADERS = (GRID[0] ?? []).map((h) => h.trim());
const MAPPING = mappingFromRoles(rolesFromMapping(guessMapping(HEADERS), HEADERS), HEADERS);

const CATEGORIES: CategoryDto[] = [
  {
    id: 'cat-bazar',
    name: 'Groceries',
    nameBn: 'বাজার',
    kind: 'EXPENSE',
    icon: null,
    color: null,
    sortOrder: 1,
  },
  {
    id: 'cat-salary',
    name: 'Salary',
    nameBn: 'বেতন',
    kind: 'INCOME',
    icon: null,
    color: null,
    sortOrder: 2,
  },
];

const NOTHING: DuplicateReport = {
  scope: 'ACCOUNT',
  accountId: 'acc-1',
  rows: [],
  flaggedRows: 0,
};

/** The second row of the file — the salary — matched to something recorded. */
const SALARY_FLAGGED: DuplicateReport = {
  scope: 'ACCOUNT',
  accountId: 'acc-1',
  rows: [
    {
      lineNumber: 3,
      moreCount: 0,
      matches: [
        {
          transactionId: 'txn-1',
          date: '2026-03-31',
          amountMinor: 5_000_000,
          direction: 'IN',
          description: 'বেতন',
          reference: null,
          accountId: 'acc-1',
          accountName: 'নগদ',
          source: 'SMS',
          createdAt: '2026-03-31T10:00:00.000Z',
        },
      ],
    },
  ],
  flaggedRows: 1,
};

const review = (duplicates: DuplicateReport, decisions = new Map()) =>
  buildReview(GRID, MAPPING, 'DMY', duplicates, CATEGORIES, decisions);

describe('buildReview', () => {
  it('lists readable rows and unreadable lines together, in file order', () => {
    const built = review(NOTHING);
    expect(built.rows.map((row) => row.lineNumber)).toEqual([2, 3, 4]);
    expect(built.rows[2]?.problem).toContain('তারিখ');
    expect(built.counts).toMatchObject({ readable: 2, broken: 1 });
  });

  it('keeps money as exact poisha', () => {
    // Number('1234.29') * 100 is 123428.99999999999.
    expect(review(NOTHING).rows[0]?.amountMinor).toBe(123_429);
    expect(review(NOTHING).rows[0]?.direction).toBe('OUT');
  });

  it("opens the picker on the category the file's own column named", () => {
    expect(review(NOTHING).rows[0]?.categoryId).toBe('cat-bazar');
    expect(review(NOTHING).rows[1]?.categoryId).toBe('');
  });

  it('ticks every readable row when nothing is in doubt', () => {
    const built = review(NOTHING);
    expect(built.counts.approved).toBe(2);
    expect(built.netMinor).toBe(5_000_000 - 123_429);
  });

  it('leaves a possible duplicate unticked', () => {
    /* The safety property. A flagged row starting ticked would make the default
       action on an ambiguous row "double it", one press away. */
    const built = review(SALARY_FLAGGED);
    expect(approvedByDefault([])).toBe(true);
    expect(built.rows[1]?.matches).toHaveLength(1);
    expect(built.rows[1]?.approved).toBe(false);
    expect(built.counts).toMatchObject({ approved: 1, flagged: 1, approvedFlagged: 0 });
  });

  it('never removes, reorders or alters a flagged row', () => {
    // It is a warning and only a warning.
    const clean = review(NOTHING);
    const flagged = review(SALARY_FLAGGED);
    expect(flagged.rows.map((r) => r.lineNumber)).toEqual(clean.rows.map((r) => r.lineNumber));
    expect(flagged.rows[1]?.amountMinor).toBe(clean.rows[1]?.amountMinor);
  });

  it("keeps a person's own answer when the warnings change underneath it", () => {
    /* Choosing an account re-runs the check and can flag a row that was not
       flagged before. Somebody who has already said yes to that row has said
       so, and their answer must survive. */
    const said = new Map([[3, { approved: true }]]);
    const built = review(SALARY_FLAGGED, said);
    expect(built.rows[1]?.approved).toBe(true);
    expect(built.counts.approvedFlagged).toBe(1);
  });
});

describe('probesFrom', () => {
  it('asks only about rows that actually parsed', () => {
    const probes = probesFrom(review(NOTHING).rows);
    expect(probes).toEqual([
      { lineNumber: 2, date: '2026-04-03', amountMinor: 123_429 },
      { lineNumber: 3, date: '2026-03-31', amountMinor: 5_000_000 },
    ]);
  });
});

describe('toApprovedRows', () => {
  it('sends only what was ticked', () => {
    const built = review(NOTHING, new Map([[2, { approved: false }]]));
    const rows = toApprovedRows(built.rows);
    expect(rows.map((row) => row.lineNumber)).toEqual([3]);
  });

  it('sends the chosen category as an id, not as free text', () => {
    const built = review(NOTHING, new Map([[3, { categoryId: 'cat-salary' }]]));
    const salary = toApprovedRows(built.rows).find((row) => row.lineNumber === 3);
    expect(salary?.categoryId).toBe('cat-salary');
    expect(salary?.categoryName).toBeNull();
  });

  it('marks a duplicate as accepted only where there was a warning to accept', () => {
    /* Sent blanket-true it would be a switch that disables the server's own
       duplicate check for the whole file, which is not what it is for. */
    const built = review(SALARY_FLAGGED, new Map([[3, { approved: true }]]));
    const rows = toApprovedRows(built.rows);
    expect(rows.find((row) => row.lineNumber === 2)?.acceptDuplicate).toBeUndefined();
    expect(rows.find((row) => row.lineNumber === 3)?.acceptDuplicate).toBe(true);
  });

  it('never sends a line it could not read', () => {
    const built = review(NOTHING, new Map([[4, { approved: true }]]));
    expect(toApprovedRows(built.rows).map((row) => row.lineNumber)).not.toContain(4);
  });
});
