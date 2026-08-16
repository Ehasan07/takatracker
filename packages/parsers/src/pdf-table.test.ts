import { describe, expect, it } from 'vitest';
import {
  dropRepeatedHeaders,
  gridFromTextItems,
  linesFromTextItems,
  type PositionedText,
} from './pdf-table.js';

/** A run of text, six points per character — close enough to a 10pt face. */
const run = (text: string, x: number, y: number): PositionedText => ({
  text,
  x,
  y,
  width: text.length * 6,
  height: 10,
});

/** A four-column statement laid out the way a report generator lays one out. */
function statement(): PositionedText[] {
  const rows: [string, string, string, string][] = [
    ['Date', 'Description', 'Debit', 'Credit'],
    ['01/07/2026', 'SALARY CREDIT', '', '50,000.00'],
    ['03/07/2026', 'BKASH SEND MONEY', '1,250.50', ''],
    ['05/07/2026', 'ATM WITHDRAWAL', '500.00', ''],
  ];
  const left = [40, 120, 320, 430];
  const items: PositionedText[] = [];
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell !== '') items.push(run(cell, left[c] as number, 100 + r * 20));
    });
  });
  return items;
}

describe('linesFromTextItems', () => {
  it('groups runs printed at the same height into one line', () => {
    const lines = linesFromTextItems(statement());
    expect(lines).toHaveLength(4);
    expect(lines[0]?.items.map((i) => i.text)).toEqual(['Date', 'Description', 'Debit', 'Credit']);
  });

  it('tolerates the sub-point wobble a generator leaves on a baseline', () => {
    const lines = linesFromTextItems([run('a', 10, 100), run('b', 60, 101.4)]);
    expect(lines).toHaveLength(1);
  });

  it('drops the synthetic spaces an extractor inserts between runs', () => {
    /* They exist because there is a gap, so keeping them would paint over the
       very emptiness the column finder reads. */
    const lines = linesFromTextItems([run('a', 10, 100), run('   ', 20, 100), run('b', 60, 100)]);
    expect(lines[0]?.items).toHaveLength(2);
  });
});

describe('gridFromTextItems', () => {
  it('rebuilds a table with one column per column', () => {
    const grid = gridFromTextItems(statement());
    expect(grid).toHaveLength(4);
    expect(grid[0]).toEqual(['Date', 'Description', 'Debit', 'Credit']);
    expect(grid[1]).toEqual(['01/07/2026', 'SALARY CREDIT', '', '50,000.00']);
    expect(grid[3]).toEqual(['05/07/2026', 'ATM WITHDRAWAL', '500.00', '']);
  });

  it('does not split a description at its own word gaps', () => {
    // The whole reason columns are found across every row at once.
    const grid = gridFromTextItems(statement());
    expect(grid[2]?.[1]).toBe('BKASH SEND MONEY');
  });

  it('keeps a right-aligned amount column together', () => {
    /* Right-aligned numbers have their left edges all over the place; only the
       empty strip in front of the widest of them says where the column starts. */
    const items: PositionedText[] = [];
    const rows = [
      ['Date', 'Amount'],
      ['01/07/2026', '50,000.00'],
      ['03/07/2026', '60.00'],
      ['05/07/2026', '1,250.50'],
    ];
    rows.forEach((row, r) => {
      const right = 500;
      items.push(run(row[0] as string, 40, 100 + r * 20));
      const text = row[1] as string;
      items.push(run(text, right - text.length * 6, 100 + r * 20));
    });

    const grid = gridFromTextItems(items);
    expect(grid.map((row) => row.length)).toEqual([2, 2, 2, 2]);
    expect(grid[3]).toEqual(['05/07/2026', '1,250.50']);
  });

  it('survives one summary line ruled across every column', () => {
    /* A "Total for July" row inks over every gutter. Strict gutter-finding
       loses the whole table to it, so the second pass allows a few rows to
       cross a boundary — but only when the strict pass found nothing. */
    const items = statement();
    items.push(run('Total for the period 51,750.50 across 3 transactions', 40, 200));

    const grid = gridFromTextItems(items);
    expect(grid[0]).toEqual(['Date', 'Description', 'Debit', 'Credit']);
    expect(grid[1]?.[0]).toBe('01/07/2026');
  });

  it('does not let a letterhead decide where the columns are', () => {
    /* Three lines of bank address, each one long run reaching from the left
       margin into the middle of the table. They ink over the gutter between the
       date and the description, and if they got a vote the two columns would
       merge and every row would fail to parse a date. */
    const items = statement();
    items.unshift(
      run('SONALI BANK LIMITED', 40, 40),
      run('Motijheel Branch, Dhaka', 40, 60),
      run('Statement for July 2026', 40, 80),
    );

    const grid = gridFromTextItems(items);
    expect(grid[3]).toEqual(['Date', 'Description', 'Debit', 'Credit']);
    expect(grid[4]).toEqual(['01/07/2026', 'SALARY CREDIT', '', '50,000.00']);
    // Kept, not thrown away — it just gets no say.
    expect(grid[0]?.[0]).toBe('SONALI BANK LIMITED');
  });

  it('says nothing at all when there is no text', () => {
    // A scan is an image; the extractor finds no runs and this must not invent any.
    expect(gridFromTextItems([])).toEqual([]);
  });
});

describe('dropRepeatedHeaders', () => {
  it('removes the heading each later page repeats', () => {
    const grid = [
      ['Date', 'Description', 'Amount'],
      ['01/07/2026', 'A', '10'],
      ['Date', 'Description', 'Amount'],
      ['02/07/2026', 'B', '20'],
    ];
    expect(dropRepeatedHeaders(grid)).toEqual([
      ['Date', 'Description', 'Amount'],
      ['01/07/2026', 'A', '10'],
      ['02/07/2026', 'B', '20'],
    ]);
  });

  it('only removes an exact repeat', () => {
    const grid = [
      ['Date', 'Description', 'Amount'],
      ['Date of value', 'Description', 'Amount'],
    ];
    expect(dropRepeatedHeaders(grid)).toHaveLength(2);
  });
});
