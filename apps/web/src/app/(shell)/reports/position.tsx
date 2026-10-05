'use client';

/**
 * Where the household stands, in three groups — and what each credit card's
 * last bill says.
 *
 * ## Why one total was not enough
 *
 * The reports screen already carried সম্পদ, দায় and হাতে নগদ as three bare
 * figures. Three numbers with nothing under them answer nothing anybody
 * actually asks. "দায় ৳1,62,400" does not say whether that is a car loan
 * amortising quietly at a rate fixed years ago or a credit card compounding at
 * thirty-odd percent, and those two facts lead to opposite decisions this
 * month. "সম্পদ ৳6,14,500" mixes a plot of land nobody is going to sell with
 * ৳3,300 in a bikash wallet. So each of the three is a group with its own
 * total and its own parts, and the parts are the point.
 *
 * ## The one property every block here keeps
 *
 * **The rows add up to the heading above them.** That is enforced in
 * `packages/core/src/reports.ts`, where the totals and the groups are built in
 * one pass from one list, and asserted in `reports.test.ts`. Nothing on this
 * page re-adds anything: `GroupBlock` is handed a total and a list of parts,
 * and it prints both. If they ever disagreed it would be the server's
 * arithmetic on screen, not a rendering bug — which is the only place a
 * disagreement can be found and fixed.
 *
 * ## What an undrawn credit limit is not
 *
 * Money. It is what the bank still holds and may withdraw, so it is not cash
 * under IAS 7.6 and not a resource the entity controls. It appears once, on a
 * card's own row, as a disclosure beside the debt (IAS 7.50(a)) — never inside
 * সম্পদ, never inside হাতে নগদ, and never added to anything.
 *
 * ## Colour is the third signal, never the first
 *
 * Every proportion bar has a name, an amount and a share printed beside it. The
 * bars are percentages of a container — pixels, never money — and every taka
 * figure on the screen is rendered by `<Money>` from integer poisha. Turn the
 * palette off entirely and the panel still reads.
 */

import { useQuery } from '@tanstack/react-query';
import { CreditCard, Landmark, Wallet } from '@/components/icons';
import { Money } from '@/components/money';
import { seriesColour } from '@/components/charts/palette';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { Panel, PanelSkeleton, QueryError } from './parts';
import { fetchBalanceSheet, fetchCardStatements, reportKeys } from './queries';
import { bnDate, bnNum } from './range';
import type { AssetKind, CardStatementDto } from './types';

/**
 * What each account type is called on this screen.
 *
 * Worded for reading rather than for choosing: the accounts screen's picker
 * says "সম্পদ (জমি, স্বর্ণ, গাড়ি)" because somebody is about to pick one, and a
 * report wants the noun a heading takes. Only the types that can reach a group
 * are here — the liquid three and the three kinds of obligation. A type that
 * somehow arrives without a label falls back to its own name rather than to a
 * blank row, so a new account type shows up as ugly instead of as missing.
 *
 * A function and not a constant table, so the string is resolved when the row
 * renders rather than when this module is first imported.
 */
function typeLabel(type: string): string {
  switch (type) {
    case 'CASH':
      return t('reports.position.type.CASH', 'নগদ');
    case 'BANK':
      return t('reports.position.type.BANK', 'ব্যাংকে');
    case 'MOBILE_WALLET':
      return t('reports.position.type.MOBILE_WALLET', 'মোবাইল ওয়ালেটে');
    case 'CREDIT_CARD':
      return t('reports.position.type.CREDIT_CARD', 'ক্রেডিট কার্ড');
    case 'PAYABLE':
      return t('reports.position.type.PAYABLE', 'দেনা');
    case 'LIABILITY':
      return t('reports.position.type.LIABILITY', 'ঋণ');
    default:
      return type;
  }
}

/** The five kinds of thing an `ASSET` account can be, worded as the সম্পদ screen words them. */
function kindLabel(kind: AssetKind): string {
  switch (kind) {
    case 'PROPERTY':
      return t('reports.position.kind.PROPERTY', 'স্থাবর সম্পত্তি');
    case 'VEHICLE':
      return t('reports.position.kind.VEHICLE', 'যানবাহন');
    case 'GOLD':
      return t('reports.position.kind.GOLD', 'স্বর্ণ ও গয়না');
    case 'INVESTMENT':
      return t('reports.position.kind.INVESTMENT', 'বিনিয়োগ');
    default:
      return t('reports.position.kind.OTHER', 'অন্যান্য');
  }
}

interface GroupRow {
  key: string;
  label: string;
  amountMinor: number;
  count: number;
}

/**
 * One heading, its total, and the parts it is made of.
 *
 * The bar is measured against the group's own total, so a row's length is its
 * share of *this* group — not of the balance sheet, which would make the
 * liquid block a row of slivers beside a plot of land and say nothing. A
 * negative part (an overdrawn current account) draws no bar and keeps its
 * figure, because a bar cannot be minus four centimetres long and pretending
 * otherwise is how a screen hides an overdraft.
 *
 * The fills come from the categorical palette rather than from the income and
 * expense tones, and the debt block is not therefore drawn in red. These rows
 * are *kinds of thing*, not directions of money: a credit card is not worse
 * than a car loan, it is a different obligation, and painting the larger one
 * red would be the chart making a judgement the reader has not asked for. The
 * heading says what the block is; the palette only tells one row from the next.
 * Slot order matters — `seriesColour` guarantees separation between
 * *neighbours*, and these lists arrive sorted, so the index is the sort
 * position and nothing else.
 */
function GroupBlock({
  title,
  hint,
  icon: Icon,
  totalMinor,
  rows,
  emptyText,
  testId,
  className,
}: {
  title: string;
  hint: string;
  icon: typeof Wallet;
  totalMinor: number;
  rows: readonly GroupRow[];
  emptyText: string;
  testId: string;
  className?: string;
}) {
  return (
    <section data-testid={testId} className={cn('min-w-0', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-ink flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <Icon className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{title}</span>
        </h3>
        <Money minor={totalMinor} className="shrink-0 text-base font-semibold" decimals={false} />
      </div>
      <p className="text-ink-muted mt-0.5 text-xs">{hint}</p>

      {rows.length === 0 ? (
        <p className="text-ink-muted mt-2 text-xs">{emptyText}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((row, index) => (
            <li key={row.key}>
              <p className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-ink min-w-0 truncate">
                  {row.label}
                  {row.count > 1 ? (
                    <span className="text-ink-muted">
                      {' '}
                      ·{' '}
                      {t('reports.position.accountCount', '{n}টি').replace('{n}', bnNum(row.count))}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  {/* The share is text, so the bar beside it is a picture of a
                      number the reader already has rather than the only place
                      the proportion exists. */}
                  <span className="text-ink-muted">
                    {sharePercent(row.amountMinor, totalMinor)}
                  </span>
                  <Money minor={row.amountMinor} decimals={false} />
                </span>
              </p>
              <div className="bg-greenbar mt-1 h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="h-1.5 rounded-full motion-safe:transition-all"
                  style={{
                    width: barWidth(row.amountMinor, totalMinor),
                    background: seriesColour(index),
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A row's share of its group, as text, with the digits the reader uses.
 *
 * Integer poisha in, one decimal out, and `Math.floor(x + 0.5)` rather than
 * `Math.round`, which is banned repo-wide so that money never touches float
 * rounding. Empty when there is nothing to be a share of, rather than `NaN%`.
 */
function sharePercent(amountMinor: number, totalMinor: number): string {
  if (totalMinor <= 0 || amountMinor <= 0) return '';
  const tenths = Math.floor((amountMinor / totalMinor) * 1000 + 0.5);
  return `${bnNum((tenths / 10).toFixed(1))}%`;
}

/** A percentage of a container — a screenful of pixels, never money. */
function barWidth(amountMinor: number, totalMinor: number): string {
  if (totalMinor <= 0 || amountMinor <= 0) return '0%';
  return `${Math.min(100, (amountMinor / totalMinor) * 100)}%`;
}

/**
 * The three groups: what is owed, what is owned, what is spendable.
 *
 * It runs the same `balance-sheet` query the panels above it run, under the
 * same key, so react-query serves it from cache and this costs no second
 * request. That also means the three totals here and the three on নিট সম্পদ
 * are one fetch and cannot be a moment apart.
 */
export function PositionPanel({ asOfText }: { asOfText: string }) {
  const sheet = useQuery({ queryKey: reportKeys.balanceSheet(), queryFn: fetchBalanceSheet });

  return (
    <Panel
      title={t('reports.position.title', 'কোথায় দাঁড়িয়ে আছেন')}
      scope={asOfText}
      testId="position"
    >
      {sheet.isError ? (
        <QueryError
          message={t('reports.position.failed', 'অবস্থানের হিসাব আনা যায়নি।')}
          onRetry={() => void sheet.refetch()}
        />
      ) : sheet.isPending ? (
        <PanelSkeleton rows={5} />
      ) : (
        <>
          {/* One column on a phone, three side by side from a tablet up. The
              rules between the columns are drawn per block rather than by
              `divide-x`, so the padding that keeps a figure off a border can
              travel with them — the same arrangement the সারসংক্ষেপ panel uses. */}
          <div className="divide-rule mt-3 grid grid-cols-1 gap-4 divide-y md:grid-cols-3 md:gap-5 md:divide-x md:divide-y-0">
            {(
              [
                {
                  testId: 'position-owed',
                  title: t('reports.position.owed', 'যা দেনা আছে'),
                  hint: t('reports.position.owedHint', 'ধরন অনুযায়ী মোট দায়'),
                  icon: CreditCard,
                  totalMinor: sheet.data.liabilitiesMinor,
                  emptyText: t('reports.position.noDebt', 'কোনো দায় নেই।'),
                  rows: sheet.data.liabilityGroups.map((group) => ({
                    key: group.type,
                    label: typeLabel(group.type),
                    amountMinor: group.amountMinor,
                    count: group.count,
                  })),
                },
                {
                  testId: 'position-owned',
                  title: t('reports.position.owned', 'যা নিজের'),
                  hint: t('reports.position.ownedHint', 'জমি, গাড়ি, স্বর্ণ, বিনিয়োগ'),
                  icon: Landmark,
                  totalMinor: sheet.data.groupedAssetsMinor,
                  emptyText: t('reports.position.noAssets', 'এমন কোনো সম্পদ নেই।'),
                  rows: sheet.data.assetGroups.map((group) => ({
                    key: group.kind,
                    label: kindLabel(group.kind),
                    amountMinor: group.amountMinor,
                    count: group.count,
                  })),
                },
                {
                  testId: 'position-liquid',
                  title: t('reports.position.liquid', 'যা এখনই খরচ করা যায়'),
                  hint: t('reports.position.liquidHint', 'নগদ, ব্যাংক ও মোবাইল ওয়ালেট'),
                  icon: Wallet,
                  totalMinor: sheet.data.liquidMinor,
                  emptyText: t('reports.position.noLiquid', 'হাতে কিছু নেই।'),
                  rows: sheet.data.liquidGroups.map((group) => ({
                    key: group.type,
                    label: typeLabel(group.type),
                    amountMinor: group.amountMinor,
                    count: group.count,
                  })),
                },
              ] as const
            ).map((block, i) => (
              <GroupBlock
                key={block.testId}
                {...block}
                className={cn(i > 0 && 'pt-4 md:pl-5 md:pt-0')}
              />
            ))}
          </div>

          {/* যা নিজের is the `ASSET` accounts and nothing else. Somebody adding
              the three headings up and finding they miss মোট সম্পদ deserves the
              reason rather than a bug report — a DPS is an asset, is not a
              possession, and is not money you can spend this afternoon. */}
          <p className="text-ink-muted border-rule mt-4 border-t pt-3 text-xs">
            {t(
              'reports.position.footnote',
              'সঞ্চয়পত্র ও ডিপিএস সম্পদের মধ্যে গোনা হয়, কিন্তু "যা নিজের"-এ নেই — ওগুলো জিনিস নয় আর আজই ভাঙানো যায় না। মোট সম্পদ ও নিট সম্পদ উপরের অংশে।',
            )}
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * What each credit card's last bill says is owed.
 *
 * ## The claim this panel makes, and the one it refuses to make
 *
 * স্টেটমেন্ট অনুযায়ী is the balance on the card **on the day the bill closed**,
 * read off the ledger. It is not today's balance, and it is not today's balance
 * with later payments added back — a bill is a photograph of a moment. Today's
 * figure is beside it under its own heading, and the movement between them has
 * its own line, because the gap between "what the bill said" and "what I owe
 * now" is the single thing people get wrong about card debt.
 *
 * What it cannot know is printed on the panel rather than left to be
 * discovered. These books hold what the household recorded: interest, the late
 * fee, the annual fee and the foreign-currency markup are in this figure only
 * if somebody typed them in, and the bank may post a purchase into a different
 * cycle than the day it happened. So this is *what your books say the bill
 * should be* — worth having beside the real bill, and not a thing to pay from
 * blind. A card with no statement day set gets no statement figure at all,
 * because there is no day for one to be true on; it says so and shows today's
 * balance only.
 */
export function CardStatementsPanel({ asOfText }: { asOfText: string }) {
  const cards = useQuery({
    queryKey: reportKeys.cardStatements(),
    queryFn: fetchCardStatements,
  });

  /* Nothing at all rather than an empty card. A household with no credit card
     should not be told, every time it opens the reports screen, that it has no
     credit cards. */
  if (cards.isSuccess && cards.data.cards.length === 0) return null;

  return (
    <Panel
      title={t('reports.cards.title', 'ক্রেডিট কার্ডের স্টেটমেন্ট')}
      scope={asOfText}
      testId="card-statements"
    >
      {cards.isError ? (
        <QueryError
          message={t('reports.cards.failed', 'কার্ডের হিসাব আনা যায়নি।')}
          onRetry={() => void cards.refetch()}
        />
      ) : cards.isPending ? (
        <PanelSkeleton rows={3} />
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">
                {t('reports.cards.statementTotal', 'স্টেটমেন্ট অনুযায়ী মোট দেনা')}
              </dt>
              <dd>
                <Money
                  minor={cards.data.statementTotalMinor}
                  className="text-expense block text-xl font-semibold"
                  decimals={false}
                />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">
                {t('reports.cards.currentTotal', 'এই মুহূর্তে মোট দেনা')}
              </dt>
              <dd>
                <Money
                  minor={cards.data.currentTotalMinor}
                  className="block text-xl font-semibold"
                  decimals={false}
                />
              </dd>
            </div>
          </dl>

          <ul className="divide-rule mt-4 divide-y">
            {cards.data.cards.map((card) => (
              <CardRow key={card.id} card={card} />
            ))}
          </ul>

          {cards.data.withoutStatementDay > 0 ? (
            <p className="text-ink-muted mt-3 text-xs">
              {t(
                'reports.cards.someWithoutDay',
                '{n}টি কার্ডে স্টেটমেন্টের তারিখ দেওয়া নেই, তাই ওগুলো উপরের স্টেটমেন্ট মোটে নেই।',
              ).replace('{n}', bnNum(cards.data.withoutStatementDay))}
            </p>
          ) : null}

          {/* The disclosure, on the screen, in the reader's language. A figure
              that looks like a bank's and is not is worse than no figure. */}
          <p className="text-ink-muted border-rule mt-3 border-t pt-3 text-xs">
            {t(
              'reports.cards.caveat',
              'এই হিসাব আপনার নিজের খাতা থেকে করা। ব্যাংকের সুদ, বিলম্ব ফি, বার্ষিক ফি বা ডলার লেনদেনের চার্জ যদি আপনি না লিখে থাকেন, সেগুলো এখানে নেই — আর ব্যাংক কোনো খরচ পরের বিলে তুলতে পারে। ব্যাংকের বিলের সঙ্গে মিলিয়ে দেখুন; ন্যূনতম পরিশোধের অঙ্ক এখানে বের করা যায় না।',
            )}
          </p>
        </>
      )}
    </Panel>
  );
}

/** One card: the bill, today's balance, and the arithmetic between them. */
function CardRow({ card }: { card: CardStatementDto }) {
  const name = card.accountNumberMasked ? `${card.name} ${card.accountNumberMasked}` : card.name;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-ink min-w-0 text-sm font-medium">{name}</h3>
        {card.statementDate ? (
          <p className="text-ink-muted text-xs">
            {t('reports.cards.closedOn', 'বিল কাটা হয়েছে')} {bnDate(card.statementDate)}
            {card.dueDate
              ? ` · ${t('reports.cards.dueOn', 'শেষ তারিখ')} ${bnDate(card.dueDate)}`
              : ''}
          </p>
        ) : (
          <p className="text-ink-muted text-xs">
            {t('reports.cards.noStatementDay', 'স্টেটমেন্টের তারিখ দেওয়া নেই')}
          </p>
        )}
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
        {card.statementMinor !== null ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted min-w-0 truncate text-xs">
              {t('reports.cards.statementOwed', 'স্টেটমেন্ট অনুযায়ী')}
            </dt>
            <dd>
              <Money minor={card.statementMinor} className="font-semibold" decimals={false} />
            </dd>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-muted min-w-0 truncate text-xs">
            {t('reports.cards.currentOwed', 'এখন বকেয়া')}
          </dt>
          <dd>
            <Money minor={card.currentMinor} decimals={false} />
          </dd>
        </div>
      </dl>

      {card.statementDate && card.previousStatementDate ? (
        <>
          {/* How the bill got to its figure. Four lines that must close, and
              they are on screen rather than trusted, because a reader who can
              check the arithmetic can find the entry somebody forgot. */}
          <dl className="text-ink-muted mt-2 space-y-1 text-xs">
            {(
              [
                [t('reports.cards.opening', 'আগের বিলের বকেয়া'), card.openingMinor],
                [t('reports.cards.purchases', 'এই বিলে যোগ হয়েছে'), card.purchasesMinor],
                [t('reports.cards.payments', 'এই বিলে শোধ হয়েছে'), -card.paymentsMinor],
              ] as const
            ).map(([label, minor]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <dt className="min-w-0 truncate">{label}</dt>
                <dd>
                  <Money minor={minor} decimals={false} signed />
                </dd>
              </div>
            ))}
            {card.sinceStatementMinor !== null && card.sinceStatementMinor !== 0 ? (
              <div className="flex items-baseline justify-between gap-3">
                {/* Sign and word both, never colour alone: "বেড়েছে" for a card
                    used again, "শোধ হয়েছে" for one partly paid. */}
                <dt className="min-w-0 truncate">
                  {card.sinceStatementMinor > 0
                    ? t('reports.cards.sinceUp', 'বিলের পর আরও খরচ')
                    : t('reports.cards.sinceDown', 'বিলের পর শোধ হয়েছে')}
                </dt>
                <dd>
                  <Money minor={card.sinceStatementMinor} decimals={false} signed />
                </dd>
              </div>
            ) : null}
          </dl>
          {!card.reconciled ? (
            <p className="text-expense mt-2 text-xs">
              {t('reports.cards.notReconciled', 'এই কার্ডের হিসাব মিলছে না — সহায়তা নিন।')}
            </p>
          ) : null}
        </>
      ) : null}

      {card.creditLimitMinor > 0 ? (
        <p className="text-ink-muted mt-2 text-xs">
          {t('reports.cards.limit', 'কার্ডের সীমা')}{' '}
          <Money minor={card.creditLimitMinor} className="text-ink" decimals={false} /> ·{' '}
          {t('reports.cards.undrawn', 'অ্যাভেইলেবল')}{' '}
          <Money minor={card.undrawnMinor} className="text-ink" decimals={false} />
          <span className="block">
            {t(
              'reports.cards.undrawnNote',
              'না-তোলা সীমা আপনার টাকা নয় — ব্যাংক যেকোনো সময় কমাতে পারে, তাই সম্পদ বা হাতে নগদে এটি যোগ হয় না।',
            )}
          </span>
        </p>
      ) : null}
    </li>
  );
}
