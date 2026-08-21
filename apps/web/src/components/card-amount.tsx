'use client';

import { Money } from '@/components/money';
import { t } from '@/lib/t';

/**
 * A credit card's three figures, in the order a cardholder reads them.
 *
 * ## Why three and not one
 *
 * A card is a liability, so this ledger holds it negative when money is owed —
 * correct, and unreadable at a glance. The owner looked at `+৳1,66,867.64` in
 * green and asked whether it meant due or available, which is exactly the
 * question a minus sign does not answer for anybody who is not an accountant.
 * On a card the two readings are opposites, and there is a third figure behind
 * both: the limit. So all three are printed and the arithmetic between them is
 * visible — লিমিট, what is left, and what is owed.
 *
 * ## The order, and the weight
 *
 * The limit first, because it is the fixed fact the other two are measured
 * against; then what is left to spend, which is the figure somebody standing at
 * a till wants; then what is owed, in the weight the liability subtotal is
 * actually made of. The room under a limit is the bank's money until it is
 * spent, so it is reported and never added to anything.
 *
 * ## When the books say a card is in credit
 *
 * `undrawnMinor` is `limit − drawn`, and `drawn` is zero for a card the ledger
 * thinks is in credit — so a card whose balance is wrongly positive reports its
 * *whole limit* as available, which is how this row came to read "বাকি
 * ৳3,00,000.00" for a card with ৳1,33,132.36 outstanding. That is a true
 * statement about a false balance, and printing it as though it were an answer
 * is worse than saying nothing. So in that state the row shows the credit it
 * claims and asks for the card to be checked, rather than deriving two more
 * figures from a number that cannot be right.
 */
export function CardAmount({
  minor,
  /** The room left under the limit, as the ledger derives it. */
  undrawnMinor,
  /** What the card is owed on, positive. Zero whenever the ledger says in credit. */
  drawnMinor,
  limitMinor = 0,
  /**
   * The card's own money, when it is not the workspace's.
   *
   * A dollar card printed its limit with a ৳ in front of it before the accounts
   * screen started passing this, and a workspace that does not keep its books in
   * taka printed the wrong symbol on every card it had.
   */
  currency,
  className = '',
}: {
  minor: number;
  undrawnMinor?: number;
  drawnMinor?: number;
  limitMinor?: number;
  currency?: string;
  className?: string;
}) {
  const owed = minor < 0;
  const word = owed
    ? t('dashboard.cardOwed', 'বকেয়া')
    : minor > 0
      ? t('dashboard.cardCredit', 'জমা')
      : '';

  const amount = (
    <span className="flex items-baseline justify-end gap-1.5">
      {word ? (
        <span className={`text-xs ${owed ? 'text-expense' : 'text-income'}`}>{word}</span>
      ) : null}
      {/* The magnitude: the word beside it already says which way it points, and
          a minus in front of বকেয়া reads as a double negative. */}
      <Money
        currency={currency}
        minor={Math.abs(minor)}
        className={`text-sm ${owed ? 'text-expense' : minor > 0 ? 'text-income' : ''}`}
      />
    </span>
  );

  const line = (label: string, value: number) => (
    <span className="text-ink-muted flex items-baseline gap-1.5 text-xs">
      {label}
      <Money minor={value} currency={currency} />
    </span>
  );

  if (limitMinor <= 0) {
    return <span className={`flex shrink-0 items-baseline gap-1.5 ${className}`}>{amount}</span>;
  }

  return (
    <span className={`flex shrink-0 flex-col items-end ${className}`}>
      {line(t('account.limit', 'লিমিট'), limitMinor)}
      {minor > 0 ? (
        /* Nothing derived from a balance that cannot be right. */
        <>
          {amount}
          <span className="text-expense text-[0.65rem]">
            {t('dashboard.cardCheck', 'খাতা মিলিয়ে নিন')}
          </span>
        </>
      ) : (
        <>
          {line(t('dashboard.cardAvailable', 'অ্যাভেইলেবল'), undrawnMinor ?? 0)}
          {/* `drawnMinor` and not the balance's magnitude: they are the same
              number here, and the one that is named for what it means is the one
              that will still be right if the other ever changes meaning. */}
          <span className="flex items-baseline justify-end gap-1.5">
            <span className="text-expense text-xs">{t('dashboard.cardOwed', 'বকেয়া')}</span>
            <Money minor={drawnMinor ?? 0} currency={currency} className="text-expense text-sm" />
          </span>
        </>
      )}
    </span>
  );
}
