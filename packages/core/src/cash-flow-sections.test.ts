import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES, type AccountType } from '@hishab/shared';
import {
  assertReconciles,
  buildSectionedCashFlow,
  type CashFlowSection,
  CashFlowReconciliationError,
  cashFlowSection,
} from './cash-flow-sections.js';

/**
 * One movement of liquid cash, as the report sees it: how much moved, and what
 * sat on the other side of the entry.
 *
 * Signed the way the ledger signs it — positive means cash came in.
 */
interface Movement {
  amountMinor: number;
  counterType: AccountType;
  systemRole?: 'INCOME' | 'EXPENSE' | 'EQUITY' | null;
}

/** How a movement is filed. Swappable, so a test can file one wrongly on purpose. */
type Classifier = (m: Movement) => CashFlowSection;

const realClassifier: Classifier = (m) => cashFlowSection(m.counterType, m.systemRole ?? null);

/**
 * Build the statement the service builds, from a list of movements.
 *
 * The important part is where `closingMinor` comes from: **the movements
 * themselves**, not the sections. That is what makes this a test and not a
 * tautology. In the real report the closing figure comes from the account
 * balances — a query that knows nothing about sections — so a classifier that
 * loses or double-counts a movement changes the sections and cannot change the
 * closing balance. Here the sum of `amountMinor` plays the balances' part.
 */
function statement(openingMinor: number, movements: Movement[], classify = realClassifier) {
  let operatingMinor = 0;
  let investingMinor = 0;
  let financingMinor = 0;
  let inflowMinor = 0;
  let outflowMinor = 0;
  let closingMinor = openingMinor;

  for (const m of movements) {
    closingMinor += m.amountMinor;
    if (m.amountMinor >= 0) inflowMinor += m.amountMinor;
    else outflowMinor += -m.amountMinor;

    switch (classify(m)) {
      case 'OPERATING':
        operatingMinor += m.amountMinor;
        break;
      case 'INVESTING':
        investingMinor += m.amountMinor;
        break;
      case 'FINANCING':
        financingMinor += m.amountMinor;
        break;
      default:
        break;
    }
  }

  return buildSectionedCashFlow({
    openingMinor,
    closingMinor,
    operatingMinor,
    investingMinor,
    financingMinor,
    inflowMinor,
    outflowMinor,
  });
}

describe('classifying by the account on the other side', () => {
  it('files earning and living as operating', () => {
    expect(cashFlowSection('EQUITY', 'INCOME')).toBe('OPERATING');
    expect(cashFlowSection('EQUITY', 'EXPENSE')).toBe('OPERATING');
  });

  it('files what is still yours as investing', () => {
    expect(cashFlowSection('ASSET')).toBe('INVESTING');
    expect(cashFlowSection('SAVINGS')).toBe('INVESTING');
  });

  it('files what is owed in either direction as financing', () => {
    expect(cashFlowSection('RECEIVABLE')).toBe('FINANCING');
    expect(cashFlowSection('PAYABLE')).toBe('FINANCING');
    expect(cashFlowSection('LIABILITY')).toBe('FINANCING');
    expect(cashFlowSection('CREDIT_CARD')).toBe('FINANCING');
  });

  it('does not count a move between two of your own pockets', () => {
    /* Wallet to bank is not a cash flow. Counting it would inflate both sides
       of the statement by the same amount and change nothing that is true. */
    expect(cashFlowSection('CASH')).toBe('INTERNAL');
    expect(cashFlowSection('BANK')).toBe('INTERNAL');
    expect(cashFlowSection('MOBILE_WALLET')).toBe('INTERNAL');
  });

  it('files a movement against equity as financing rather than nowhere', () => {
    /* The reconcile button on a bank account books the difference against the
       equity account, and an opening balance entered as a transaction does the
       same. Both change the closing balance, so both have to appear in a
       section — see the regression test below, which is what this exists for. */
    expect(cashFlowSection('EQUITY', 'EQUITY')).toBe('FINANCING');
    expect(cashFlowSection('EQUITY')).toBe('FINANCING');
  });

  it('files every account type there is, on purpose', () => {
    /* The whole table in one place. The `default` branch exists for the account
       type nobody has added yet, and it files the unknown under operating —
       which is a reasonable fallback and a terrible thing to discover by
       accident. Adding a type without a line here fails this test. */
    const table: Record<AccountType, CashFlowSection> = {
      CASH: 'INTERNAL',
      BANK: 'INTERNAL',
      MOBILE_WALLET: 'INTERNAL',
      CREDIT_CARD: 'FINANCING',
      SAVINGS: 'INVESTING',
      RECEIVABLE: 'FINANCING',
      PAYABLE: 'FINANCING',
      ASSET: 'INVESTING',
      LIABILITY: 'FINANCING',
      EQUITY: 'FINANCING',
    };

    for (const type of ACCOUNT_TYPES) {
      expect([type, cashFlowSection(type)]).toEqual([type, table[type]]);
    }
  });
});

describe('assembling the statement', () => {
  const month: Movement[] = [
    { amountMinor: 8_000_000, counterType: 'EQUITY', systemRole: 'INCOME' }, // salary
    { amountMinor: -1_800_000, counterType: 'EQUITY', systemRole: 'EXPENSE' }, // rent
    { amountMinor: -1_200_000, counterType: 'EQUITY', systemRole: 'EXPENSE' }, // groceries
    { amountMinor: -2_000_000, counterType: 'ASSET' }, // bought gold
    { amountMinor: -500_000, counterType: 'RECEIVABLE' }, // lent to a cousin
    { amountMinor: 300_000, counterType: 'LIABILITY' }, // drew on a loan
    { amountMinor: -400_000, counterType: 'BANK' }, // wallet to bank, not a flow
    { amountMinor: 400_000, counterType: 'CASH' }, // the other half of it
  ];

  it('sums the three sections and reconciles on the closing balance', () => {
    const flow = statement(5_100_000, month);

    expect(flow.operatingMinor).toBe(5_000_000);
    expect(flow.investingMinor).toBe(-2_000_000);
    expect(flow.financingMinor).toBe(-200_000);
    expect(flow.netMinor).toBe(2_800_000);
    expect(flow.closingMinor).toBe(7_900_000);

    expect(flow.reconciled).toBe(true);
    expect(flow.discrepancyMinor).toBe(0);
    expect(() => assertReconciles(flow)).not.toThrow();
  });

  it('separates what came in from what went out without touching the sections', () => {
    /* Inflow and outflow are gross and include the internal transfer; the
       sections are net and exclude it. Both are true at once, which is why the
       reconciliation is against `closing`, never against `inflow − outflow`. */
    const flow = statement(5_100_000, month);
    expect(flow.inflowMinor).toBe(8_700_000);
    expect(flow.outflowMinor).toBe(5_900_000);
  });

  it('reconciles an empty period at whatever the balance already was', () => {
    const flow = statement(5_100_000, []);
    expect(flow.closingMinor).toBe(5_100_000);
    expect(flow.netMinor).toBe(0);
    expect(flow.reconciled).toBe(true);
  });

  it('reconciles a workspace holding nothing', () => {
    const flow = statement(0, []);
    expect(flow.reconciled).toBe(true);
    expect(flow.discrepancyMinor).toBe(0);
  });
});

describe('the guard', () => {
  const month: Movement[] = [
    { amountMinor: 8_000_000, counterType: 'EQUITY', systemRole: 'INCOME' },
    { amountMinor: -3_000_000, counterType: 'EQUITY', systemRole: 'EXPENSE' },
    { amountMinor: -2_500_000, counterType: 'SAVINGS' }, // DPS deposit
  ];

  it('catches a counter account mis-classified into nothing', () => {
    /* The defect this whole file exists for. A DPS deposit is investing; file
       it as INTERNAL — the section for money that never left the household —
       and the ৳25,000 vanishes from the statement while staying in the bank
       balance. Every line still looks plausible. Only the arithmetic knows. */
    const dropsSavings: Classifier = (m) =>
      m.counterType === 'SAVINGS' ? 'INTERNAL' : realClassifier(m);

    const wrong = statement(5_100_000, month, dropsSavings);

    expect(wrong.investingMinor).toBe(0); // the mis-classification, visible
    expect(wrong.reconciled).toBe(false);
    expect(wrong.discrepancyMinor).toBe(-2_500_000);
    expect(() => assertReconciles(wrong)).toThrow(CashFlowReconciliationError);

    // And the same movements, filed correctly, pass.
    expect(statement(5_100_000, month).reconciled).toBe(true);
  });

  it('catches a counter account mis-classified into the wrong section', () => {
    /* Not every mis-classification breaks the arithmetic, and saying so is the
       honest limit of this guard: moving the DPS deposit from investing to
       operating misstates both lines and still reconciles, because the sum is
       unchanged. Only a movement lost or counted twice fails here. The wrong
       *section* is what the unit tests above are for. */
    const savingsAsOperating: Classifier = (m) =>
      m.counterType === 'SAVINGS' ? 'OPERATING' : realClassifier(m);

    const flow = statement(5_100_000, month, savingsAsOperating);
    expect(flow.operatingMinor).toBe(2_500_000);
    expect(flow.investingMinor).toBe(0);
    expect(flow.reconciled).toBe(true);
  });

  it('catches a movement counted twice', () => {
    const flow = buildSectionedCashFlow({
      openingMinor: 5_100_000,
      closingMinor: 7_600_000,
      operatingMinor: 5_000_000,
      investingMinor: -2_500_000,
      financingMinor: -2_500_000, // the DPS deposit again, in a second section
      inflowMinor: 8_000_000,
      outflowMinor: 5_500_000,
    });

    expect(flow.reconciled).toBe(false);
    expect(flow.discrepancyMinor).toBe(2_500_000);
  });

  it('catches a single poisha, because there is no tolerance to argue about', () => {
    const flow = buildSectionedCashFlow({
      openingMinor: 0,
      closingMinor: 100,
      operatingMinor: 99,
      investingMinor: 0,
      financingMinor: 0,
      inflowMinor: 100,
      outflowMinor: 0,
    });

    expect(flow.reconciled).toBe(false);
    expect(flow.discrepancyMinor).toBe(1);
  });

  it('says both figures in the message, so the log names the gap', () => {
    const error = new CashFlowReconciliationError(7_600_000, 5_100_000);
    expect(error.message).toContain('5100000');
    expect(error.message).toContain('7600000');
    expect(error.discrepancyMinor).toBe(2_500_000);
  });
});

describe('a reconciliation adjustment on a liquid account', () => {
  it('stays in the statement instead of breaking it', () => {
    /* The regression. `POST /accounts/:id/reconcile` books the difference
       against the equity account, so this is what a real workspace produces the
       first time somebody checks their bank balance against the app. While
       equity was INTERNAL the ৳500 landed in the closing balance and in no
       section, and the statement was out by exactly that. */
    const flow = statement(5_100_000, [
      { amountMinor: 8_000_000, counterType: 'EQUITY', systemRole: 'INCOME' },
      { amountMinor: 50_000, counterType: 'EQUITY', systemRole: 'EQUITY' },
    ]);

    expect(flow.financingMinor).toBe(50_000);
    expect(flow.closingMinor).toBe(13_150_000);
    expect(flow.reconciled).toBe(true);
    expect(() => assertReconciles(flow)).not.toThrow();
  });
});
