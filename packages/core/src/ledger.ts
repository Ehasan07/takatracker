import {
  sumMinor,
  type AccountType,
  type EntryDirection,
  type TransactionType,
} from '@hishab/shared';

/**
 * The double-entry engine. Pure functions, zero framework imports — the same
 * code runs in the API, the browser, and React Native.
 *
 * The UI never shows debits and credits. This module is what guarantees that
 * hiding them is safe.
 */

export interface EntryDraft {
  accountId: string;
  categoryId?: string | null;
  amountMinor: number;
  direction: EntryDirection;
  currency: string;
  fxRate: number;
}

export class UnbalancedTransactionError extends Error {
  constructor(
    readonly debitsMinor: number,
    readonly creditsMinor: number,
  ) {
    super(
      `Unbalanced transaction: debits ${debitsMinor} ≠ credits ${creditsMinor} (difference ${
        debitsMinor - creditsMinor
      } poisha)`,
    );
    this.name = 'UnbalancedTransactionError';
  }
}

export class InvalidEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEntryError';
  }
}

/** Amount in base currency, integer poisha. fxRate is 1 for BDT-only v1. */
function baseMinor(entry: EntryDraft): number {
  if (!Number.isInteger(entry.amountMinor)) {
    throw new InvalidEntryError(`Entry amount must be integer poisha, got ${entry.amountMinor}`);
  }
  if (entry.amountMinor <= 0) {
    throw new InvalidEntryError('Entry amounts are always positive; direction carries the sign');
  }
  if (entry.fxRate === 1) return entry.amountMinor;
  const converted = Math.trunc(entry.amountMinor * entry.fxRate);
  return converted;
}

export interface BalanceCheck {
  debitsMinor: number;
  creditsMinor: number;
  balanced: boolean;
}

export function checkBalance(entries: readonly EntryDraft[]): BalanceCheck {
  const debitsMinor = sumMinor(
    entries.filter((e) => e.direction === 'DEBIT').map((e) => baseMinor(e)),
  );
  const creditsMinor = sumMinor(
    entries.filter((e) => e.direction === 'CREDIT').map((e) => baseMinor(e)),
  );
  return { debitsMinor, creditsMinor, balanced: debitsMinor === creditsMinor };
}

/**
 * Hard invariant: SUM(debits) === SUM(credits) in base currency.
 * Mirrored by a database trigger — both must hold.
 */
export function assertBalanced(entries: readonly EntryDraft[]): void {
  if (entries.length < 2) {
    throw new InvalidEntryError('A transaction needs at least two entries');
  }
  const { debitsMinor, creditsMinor, balanced } = checkBalance(entries);
  if (debitsMinor === 0 && creditsMinor === 0) {
    throw new InvalidEntryError('A transaction cannot be for zero');
  }
  if (!balanced) throw new UnbalancedTransactionError(debitsMinor, creditsMinor);
}

/**
 * Signed effect of one entry on its own account: **debits add, credits subtract,
 * for every account type**.
 *
 * The tempting alternative is to sign by what is "normal" for the type, so a
 * credit card's balance climbs as you spend on it. Two things break when you do.
 * An opening balance is entered the same way — a ৳15,000 debt is −15,000 — and
 * it is now an ordinary entry like any other, so the two halves of the same
 * balance would disagree the moment one was posted. And `buildBalanceSheet`
 * negates liability balances to print them, which only yields a positive figure
 * if a debt is stored negative.
 *
 * The user-facing consequence is the one that settles it: a card you owe ৳5,000
 * on reads −৳5,000 in the account list, and the dashboard's total balance
 * subtracts your debts instead of counting them as wealth.
 */
export function signedEffect(entry: EntryDraft, _accountType: AccountType): number {
  const magnitude = baseMinor(entry);
  return entry.direction === 'DEBIT' ? magnitude : -magnitude;
}

/**
 * Running balance for one account: every entry's effect, and nothing else.
 *
 * There is no opening-balance argument, and that absence is the point. It used
 * to take one, because `Account.openingBalance` was a column added on top of
 * the ledger rather than posted into it — a figure inside every balance that no
 * transaction, no audit entry and no statement could account for, and that
 * carried no date, so a balance sheet dated last January showed the opening
 * balance of an account opened in June. An opening balance is now an
 * `OPENING_BALANCE` transaction against equity, on a day somebody named, and it
 * arrives here as an ordinary entry. One sum, one source.
 */
export function accountBalance(entries: readonly EntryDraft[], accountType: AccountType): number {
  return entries.reduce((acc, entry) => acc + signedEffect(entry, accountType), 0);
}

// --- Expansion: simple UI input → balanced double-entry lines ---------------

/** The three hidden accounts every user gets at signup. */
export interface SystemAccounts {
  /** Nominal account that all income is credited to. */
  incomeAccountId: string;
  /** Nominal account that all expense is debited to. */
  expenseAccountId: string;
  /** Opening balances and reconciliation adjustments land here. */
  equityAccountId: string;
}

export interface SimpleTransaction {
  type: Extract<
    TransactionType,
    'INCOME' | 'EXPENSE' | 'TRANSFER' | 'ADJUSTMENT' | 'REVALUATION' | 'OPENING_BALANCE'
  >;
  amountMinor: number;
  accountId: string;
  counterAccountId?: string | null;
  categoryId?: string | null;
  currency?: string;
}

const entry = (
  accountId: string,
  direction: EntryDirection,
  amountMinor: number,
  currency: string,
  categoryId?: string | null,
): EntryDraft => ({ accountId, direction, amountMinor, currency, fxRate: 1, categoryId });

/**
 * Turn what the user typed into balanced ledger lines.
 *
 * INCOME    debit  the account,  credit the income account  (tagged with category)
 * EXPENSE   credit the account,  debit  the expense account (tagged with category)
 * TRANSFER  credit the source,   debit  the destination
 * OPENING / ADJUSTMENT — the difference is booked against equity.
 *
 * `amountMinor` may be negative for ADJUSTMENT and OPENING_BALANCE only; every
 * other type takes a positive amount and gets its sign from `type`.
 */
export function expandSimpleTransaction(
  input: SimpleTransaction,
  system: SystemAccounts,
): EntryDraft[] {
  const currency = input.currency ?? 'BDT';
  const { amountMinor } = input;

  if (!Number.isInteger(amountMinor)) {
    throw new InvalidEntryError(`Amount must be integer poisha, got ${amountMinor}`);
  }

  switch (input.type) {
    case 'INCOME': {
      if (amountMinor <= 0) throw new InvalidEntryError('Income must be positive');
      return [
        entry(input.accountId, 'DEBIT', amountMinor, currency),
        entry(system.incomeAccountId, 'CREDIT', amountMinor, currency, input.categoryId),
      ];
    }
    case 'EXPENSE': {
      if (amountMinor <= 0) throw new InvalidEntryError('Expense must be positive');
      return [
        entry(system.expenseAccountId, 'DEBIT', amountMinor, currency, input.categoryId),
        entry(input.accountId, 'CREDIT', amountMinor, currency),
      ];
    }
    case 'TRANSFER': {
      if (amountMinor <= 0) throw new InvalidEntryError('Transfer must be positive');
      if (!input.counterAccountId) {
        throw new InvalidEntryError('A transfer needs a destination account');
      }
      if (input.counterAccountId === input.accountId) {
        throw new InvalidEntryError('Source and destination must differ');
      }
      return [
        entry(input.counterAccountId, 'DEBIT', amountMinor, currency),
        entry(input.accountId, 'CREDIT', amountMinor, currency),
      ];
    }
    /* All three move an account's value against equity and none of them is
       income or spending. They are separate types so a reader can tell a
       correction from a market movement from an opening figure — the ledger
       shape is identical, the meaning is not.

       OPENING_BALANCE is now the *only* way an opening figure enters the books.
       It used to compete with an `Account.openingBalance` column that posted
       nothing and carried no date; the column is gone and its values were moved
       through here by a data migration. */
    case 'ADJUSTMENT':
    case 'REVALUATION':
    case 'OPENING_BALANCE': {
      if (amountMinor === 0) throw new InvalidEntryError('Adjustment cannot be zero');
      const magnitude = Math.abs(amountMinor);
      // Positive = the account gains value, equity absorbs the other side.
      return amountMinor > 0
        ? [
            entry(input.accountId, 'DEBIT', magnitude, currency),
            entry(system.equityAccountId, 'CREDIT', magnitude, currency),
          ]
        : [
            entry(system.equityAccountId, 'DEBIT', magnitude, currency),
            entry(input.accountId, 'CREDIT', magnitude, currency),
          ];
    }
    default: {
      const exhaustive: never = input.type;
      throw new InvalidEntryError(`Unsupported transaction type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Reconciliation: given what the ledger thinks and what the bank says, how much
 * must be booked as an ADJUSTMENT? Returns 0 when they already agree.
 */
export function reconciliationDelta(
  computedBalanceMinor: number,
  actualBalanceMinor: number,
): number {
  if (!Number.isInteger(computedBalanceMinor) || !Number.isInteger(actualBalanceMinor)) {
    throw new InvalidEntryError('Balances must be integer poisha');
  }
  return actualBalanceMinor - computedBalanceMinor;
}
