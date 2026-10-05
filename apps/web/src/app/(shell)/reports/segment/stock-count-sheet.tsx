'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { api, endpoints, type AccountDto } from '@/lib/api';
import { t } from '@/lib/t';

/**
 * The month-end stock count.
 *
 * ## The one number, and why it is only one
 *
 * The textbook line is *opening stock + purchases − closing stock*, and two of
 * those three terms the books already hold: the inventory account carries the
 * opening balance and every purchase transferred into it, because buying stock
 * is not spending money — it changes form. So the only term left is the one no
 * ledger can know, which is what is actually on the shelf. The owner counts it,
 * types it, and the difference is what was sold.
 *
 * ## Why the ledger figure is shown before the box
 *
 * A count that differs from the books by ৳20 and one that differs by ৳2,00,000
 * are different events, and only one of them is a month's trading. Showing the
 * figure being contradicted is what lets somebody notice a missing purchase
 * before they post an entry that swallows it as cost of sales.
 *
 * ## What it refuses
 *
 * Counting *more* than the books hold means a purchase was never recorded. The
 * server refuses it rather than writing the difference as income — turning a
 * missing purchase into profit is the one direction this must never round —
 * and the message says which entry to go and write.
 */
interface CountResult {
  ledgerMinor: number;
  countedMinor: number;
  costOfGoodsSoldMinor: number;
  transactionId: string;
}

const today = (): string => toLocalDateString(new Date());

export function StockCountSheet({
  open,
  onOpenChange,
  tagId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The venture's tag, so the entry reaches its statement and not only the household's. */
  tagId: string;
}) {
  const [accountId, setAccountId] = React.useState('');
  const [date, setDate] = React.useState(today);
  const [counted, setCounted] = React.useState('');
  const [done, setDone] = React.useState<CountResult | null>(null);
  const queryClient = useQueryClient();

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  /* Stock is an asset, so only assets are offered. A count against a bank
     account would post the whole balance as cost of sales. */
  const stockAccounts = React.useMemo(
    () => (accounts.data ?? []).filter((a: AccountDto) => a.type === 'ASSET' && !a.isArchived),
    [accounts.data],
  );

  React.useEffect(() => {
    if (!accountId && stockAccounts[0]) setAccountId(stockAccounts[0].id);
  }, [accountId, stockAccounts]);

  const preview = useQuery({
    queryKey: ['business', 'stock-count', accountId, date],
    queryFn: () =>
      api<{ ledgerMinor: number; accountName: string }>(
        `/business/stock-count?accountId=${accountId}&date=${date}`,
      ),
    enabled: open && accountId !== '',
  });

  const countedMinor = counted.trim() ? parseMoneyToMinor(counted) : null;
  const ledgerMinor = preview.data?.ledgerMinor ?? null;
  const cost = ledgerMinor !== null && countedMinor !== null ? ledgerMinor - countedMinor : null;

  const post = useMutation({
    mutationFn: () =>
      api<CountResult>('/business/stock-count', {
        method: 'POST',
        body: { accountId, date, countedMinor, ...(tagId ? { tagId } : {}) },
      }),
    onSuccess: async (result) => {
      setDone(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['reports'] }),
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['business'] }),
      ]);
    },
  });

  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      setCounted('');
      setDone(null);
      post.reset();
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={close}
      title={t('segment.countTitle', 'মাস শেষে মজুদ গণনা')}
      description={t(
        'segment.countBlurb',
        'দোকানে যা আছে গুনে লিখুন — বাকিটা বিক্রি হয়ে গেছে ধরে হিসাব হবে',
      )}
    >
      {done ? (
        <div className="flex flex-col gap-3">
          <p className="text-ink text-sm">
            {t('segment.countDone', 'লেখা হয়ে গেছে। বিক্রীত পণ্যের ব্যয় হিসেবে বসেছে:')}
          </p>
          <Money
            minor={done.costOfGoodsSoldMinor}
            className="text-expense text-2xl font-extrabold"
          />
          <p className="text-ink-muted text-sm">
            {t(
              'segment.countDoneHint',
              'মজুদ অ্যাকাউন্টে এখন ঠিক ততটুকুই আছে যতটুকু আপনি গুনেছেন।',
            )}
          </p>
          <Button onClick={() => close(false)} size="block">
            {t('common.close', 'বন্ধ করুন')}
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (countedMinor !== null && accountId) post.mutate();
          }}
        >
          <Field label={t('segment.countAccount', 'মজুদ অ্যাকাউন্ট')} htmlFor="sc-account">
            <Select
              id="sc-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {stockAccounts.length === 0 ? (
                <option value="">{t('segment.countNoAccount', 'কোনো সম্পদ অ্যাকাউন্ট নেই')}</option>
              ) : null}
              {stockAccounts.map((account: AccountDto) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('segment.countDate', 'গণনার তারিখ')} htmlFor="sc-date">
            <Input
              id="sc-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>

          {/* The figure being contradicted, before the box that contradicts it. */}
          <div className="border-rule bg-greenbar rounded-xl border p-3">
            <p className="text-ink-muted text-xs">
              {t('segment.countLedger', 'খাতা অনুযায়ী মজুদ')}
            </p>
            {ledgerMinor === null ? (
              <p className="text-ink-muted text-sm">{t('common.loading', 'আসছে…')}</p>
            ) : (
              <Money minor={ledgerMinor} className="text-ink text-lg font-semibold" />
            )}
            <p className="text-ink-muted mt-1 text-xs">
              {t('segment.countLedgerHint', 'শুরুর মজুদ + এই সময়ে যা কিনেছেন')}
            </p>
          </div>

          <Field label={t('segment.countCounted', 'গুনে যা পেলেন (৳)')} htmlFor="sc-counted">
            <Input
              id="sc-counted"
              inputMode="decimal"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              placeholder="50000"
            />
          </Field>

          {cost !== null && cost > 0 ? (
            <div className="border-rule rounded-xl border p-3">
              <p className="text-ink-muted text-xs">
                {t('segment.countCost', 'বিক্রীত পণ্যের ব্যয় হবে')}
              </p>
              <Money minor={cost} className="text-expense text-xl font-bold" />
            </div>
          ) : null}

          {post.isError ? (
            <p className="text-expense text-sm">{(post.error as Error).message}</p>
          ) : null}

          <Button
            type="submit"
            size="block"
            disabled={!accountId || countedMinor === null || post.isPending}
          >
            {post.isPending
              ? t('segment.countWorking', 'লেখা হচ্ছে…')
              : t('segment.countGo', 'হিসাবে বসিয়ে দিন')}
          </Button>
        </form>
      )}
    </Sheet>
  );
}
