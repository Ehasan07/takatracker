import { describe, expect, it } from 'vitest';
import {
  accountBalance,
  assertBalanced,
  checkBalance,
  expandSimpleTransaction,
  InvalidEntryError,
  reconciliationDelta,
  signedEffect,
  UnbalancedTransactionError,
  type EntryDraft,
  type SystemAccounts,
} from './ledger.js';

const system: SystemAccounts = {
  incomeAccountId: 'sys-income',
  expenseAccountId: 'sys-expense',
  equityAccountId: 'sys-equity',
};

const e = (accountId: string, direction: 'DEBIT' | 'CREDIT', amountMinor: number): EntryDraft => ({
  accountId,
  direction,
  amountMinor,
  currency: 'BDT',
  fxRate: 1,
});

describe('assertBalanced', () => {
  it('accepts a balanced pair', () => {
    expect(() => assertBalanced([e('a', 'DEBIT', 5000), e('b', 'CREDIT', 5000)])).not.toThrow();
  });

  it('rejects an unbalanced transaction', () => {
    expect(() => assertBalanced([e('a', 'DEBIT', 5000), e('b', 'CREDIT', 4999)])).toThrow(
      UnbalancedTransactionError,
    );
  });

  it('reports the difference in poisha', () => {
    try {
      assertBalanced([e('a', 'DEBIT', 5000), e('b', 'CREDIT', 4900)]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as UnbalancedTransactionError).message).toContain('100 poisha');
    }
  });

  it('rejects a single-sided transaction', () => {
    expect(() => assertBalanced([e('a', 'DEBIT', 5000)])).toThrow(InvalidEntryError);
  });

  it('rejects negative and float entry amounts', () => {
    expect(() => assertBalanced([e('a', 'DEBIT', -100), e('b', 'CREDIT', -100)])).toThrow(
      InvalidEntryError,
    );
    expect(() => assertBalanced([e('a', 'DEBIT', 10.5), e('b', 'CREDIT', 10.5)])).toThrow(
      InvalidEntryError,
    );
  });

  it('balances a split across many lines', () => {
    const entries = [
      e('cash', 'CREDIT', 10000),
      e('exp1', 'DEBIT', 6000),
      e('exp2', 'DEBIT', 4000),
    ];
    expect(checkBalance(entries)).toEqual({
      debitsMinor: 10000,
      creditsMinor: 10000,
      balanced: true,
    });
  });
});

describe('expandSimpleTransaction', () => {
  it('books an expense as credit-account / debit-expense and stays balanced', () => {
    const entries = expandSimpleTransaction(
      { type: 'EXPENSE', amountMinor: 25000, accountId: 'cash', categoryId: 'cat-food' },
      system,
    );
    expect(entries).toHaveLength(2);
    expect(() => assertBalanced(entries)).not.toThrow();
    const cash = entries.find((x) => x.accountId === 'cash');
    expect(cash?.direction).toBe('CREDIT');
    const exp = entries.find((x) => x.accountId === 'sys-expense');
    expect(exp?.direction).toBe('DEBIT');
    expect(exp?.categoryId).toBe('cat-food');
  });

  it('books income the other way round', () => {
    const entries = expandSimpleTransaction(
      { type: 'INCOME', amountMinor: 5000000, accountId: 'bank', categoryId: 'cat-salary' },
      system,
    );
    expect(() => assertBalanced(entries)).not.toThrow();
    expect(entries.find((x) => x.accountId === 'bank')?.direction).toBe('DEBIT');
    expect(entries.find((x) => x.accountId === 'sys-income')?.direction).toBe('CREDIT');
  });

  it('moves money between two real accounts on a transfer', () => {
    const entries = expandSimpleTransaction(
      { type: 'TRANSFER', amountMinor: 100000, accountId: 'bank', counterAccountId: 'bkash' },
      system,
    );
    expect(() => assertBalanced(entries)).not.toThrow();
    expect(entries.find((x) => x.accountId === 'bank')?.direction).toBe('CREDIT');
    expect(entries.find((x) => x.accountId === 'bkash')?.direction).toBe('DEBIT');
  });

  it('rejects a transfer to the same account', () => {
    expect(() =>
      expandSimpleTransaction(
        { type: 'TRANSFER', amountMinor: 100, accountId: 'bank', counterAccountId: 'bank' },
        system,
      ),
    ).toThrow(InvalidEntryError);
  });

  it('books a negative adjustment against equity', () => {
    const entries = expandSimpleTransaction(
      { type: 'ADJUSTMENT', amountMinor: -750, accountId: 'cash' },
      system,
    );
    expect(() => assertBalanced(entries)).not.toThrow();
    expect(entries.find((x) => x.accountId === 'cash')?.direction).toBe('CREDIT');
    expect(entries.find((x) => x.accountId === 'sys-equity')?.direction).toBe('DEBIT');
  });
});

describe('balances', () => {
  it('increases a debit-normal account on debit', () => {
    expect(signedEffect(e('cash', 'DEBIT', 500), 'CASH')).toBe(500);
    expect(signedEffect(e('cash', 'CREDIT', 500), 'CASH')).toBe(-500);
  });

  it('increases a credit-normal account on credit', () => {
    expect(signedEffect(e('card', 'CREDIT', 500), 'CREDIT_CARD')).toBe(500);
    expect(signedEffect(e('card', 'DEBIT', 500), 'CREDIT_CARD')).toBe(-500);
  });

  it('walks a full month of a cash account', () => {
    const entries = [
      e('cash', 'DEBIT', 5000000), // salary in
      e('cash', 'CREDIT', 250000), // groceries
      e('cash', 'CREDIT', 1200000), // rent
    ];
    expect(accountBalance(0, entries, 'CASH')).toBe(3550000);
  });
});

describe('reconciliationDelta', () => {
  it('is zero when the ledger already agrees with the bank', () => {
    expect(reconciliationDelta(123456, 123456)).toBe(0);
  });
  it('is the signed difference otherwise', () => {
    expect(reconciliationDelta(100000, 99500)).toBe(-500);
    expect(reconciliationDelta(100000, 100500)).toBe(500);
  });
});
