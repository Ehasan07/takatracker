'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Field, Input, Select } from '@/components/ui/field';
import { toLocalDateString } from '@hishab/shared';
import { fmtDate } from '@/lib/format';
import { t } from '@/lib/t';
import { fetchTags, tagKeys } from '../../tags/queries';
import { fetchIncomeStatement, reportKeys } from '../queries';
import type { CategoryNode, IncomeStatementDto } from '../types';

/**
 * Did the business make money?
 *
 * ## Why a tag and not a set of accounts
 *
 * A sole proprietorship in Bangladesh usually has no bank account of its own.
 * The shop's takings, the stock it buys and the family's groceries all pass
 * through the same bKash, and no amount of account structure separates them —
 * there is one wallet and it genuinely holds both. What separates them is the
 * label on each row. Accounting calls this the business entity concept: the
 * business is kept as a separate person in the books even where the law says it
 * is not one, and here the tag is what makes it separate.
 *
 * So this screen is the household's own income statement drawn for one tag.
 * Same figures, same cash basis, same categories — narrowed to the rows the
 * owner said belong to the venture.
 *
 * ## Why the word changes
 *
 * The statements page says উদ্বৃত্ত, because a household does not trade and
 * calling what is left over a profit invites a comparison that means nothing.
 * A shop does trade. The same arithmetic is লাভ when it is positive and
 * লোকসান when it is not, and a screen that reports a loss as a "surplus of
 * −৳5,000" is asking its reader to do the translation.
 */

const today = (): string => toLocalDateString(new Date());
const firstOfMonth = (): string => `${today().slice(0, 7)}-01`;

export default function SegmentPage() {
  const [tagId, setTagId] = React.useState('');
  const [from, setFrom] = React.useState(firstOfMonth);
  const [to, setTo] = React.useState(today);

  const period = React.useMemo(() => ({ from, to }), [from, to]);
  const tags = useQuery({ queryKey: tagKeys.list(''), queryFn: () => fetchTags('') });

  /* Nothing is asked for until a venture is chosen. The whole-household answer
     is the statements page and already exists; an unfiltered figure here would
     be the same number under a heading that says শুধু এই ব্যবসার. */
  const statement = useQuery({
    queryKey: reportKeys.incomeStatement(period, undefined, tagId),
    queryFn: () => fetchIncomeStatement(period, undefined, tagId),
    enabled: tagId !== '',
  });

  const list = tags.data ?? [];

  return (
    <div className="statement mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/reports"
          className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('nav.reports', 'রিপোর্ট')}
        </Link>
        {statement.data ? (
          <button
            type="button"
            onClick={() => window.print()}
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <Printer className="h-4 w-4" aria-hidden />
            {t('statements.print', 'প্রিন্ট বা PDF')}
          </button>
        ) : null}
      </div>

      <header>
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">
          {t('segment.title', 'ব্যবসার লাভ-লোকসান')}
        </h1>
        <p className="text-ink-muted text-sm">
          {t(
            'segment.blurb',
            'এক ট্যাগের আয় আর খরচ আলাদা করে — ব্যবসার নিজের অ্যাকাউন্ট না থাকলেও',
          )}
        </p>
      </header>

      <div className="no-print flex flex-col gap-3">
        <Field label={t('segment.which', 'কোন ব্যবসা বা কাজ')} htmlFor="sg-tag">
          <Select id="sg-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">{t('segment.choose', 'ট্যাগ বেছে নিন')}</option>
            {list.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.nameBn ?? tag.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('statements.from', 'শুরুর তারিখ')} htmlFor="sg-from">
            <Input
              id="sg-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label={t('statements.to', 'শেষ তারিখ')} htmlFor="sg-to">
            <Input id="sg-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </div>

      {tags.isLoading ? null : list.length === 0 ? <NoTags /> : null}

      {tagId === '' ? null : statement.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : statement.data ? (
        <Result data={statement.data} />
      ) : null}
    </div>
  );
}

/**
 * The screen before there is anything to draw.
 *
 * Not an error and not empty space: the person is one step short of an answer,
 * and the step is the same one every time. Saying it here is cheaper than
 * having them find the tags screen and work out what it is for.
 */
function NoTags() {
  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink text-base font-semibold">
        {t('segment.noTagsTitle', 'আগে একটা ট্যাগ বানান')}
      </h2>
      <p className="text-ink-muted mt-1 text-sm">
        {t(
          'segment.noTagsBody',
          'ব্যবসার নামে একটা ট্যাগ বানিয়ে ওই ব্যবসার প্রতিটা আয় ও খরচে সেটি লাগান। একই বিকাশ বা ব্যাংক দিয়ে ব্যক্তিগত খরচ চললেও ট্যাগই দুইটাকে আলাদা রাখে।',
        )}
      </p>
      <Link
        href="/tags"
        className="press border-rule text-ink hover:bg-greenbar mt-3 inline-flex min-h-11 items-center rounded-md border px-3 text-sm"
      >
        {t('segment.goToTags', 'ট্যাগ পাতায় যান')}
      </Link>
    </section>
  );
}

function Result({ data }: { data: IncomeStatementDto }) {
  const profit = data.surplusMinor;
  const traded = data.incomeMinor !== 0 || data.expenseMinor !== 0;

  if (!traded) {
    return (
      <section className="rounded-card border-rule bg-surface border p-4">
        <p className="text-ink-muted text-sm">
          {t(
            'segment.nothing',
            'এই সময়ের কোনো লেনদেনে এই ট্যাগ লাগানো নেই। তারিখ বদলে দেখুন, নয়তো খাতায় গিয়ে লেনদেনগুলোতে ট্যাগ লাগান।',
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-card border-rule bg-surface loan-print-block border p-4">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <h2 className="text-ink text-base font-semibold">
          {data.segment?.name ?? t('segment.title', 'ব্যবসার লাভ-লোকসান')}
        </h2>
      </div>
      <p className="text-ink-muted text-xs">{`${fmtDate(data.from)} — ${fmtDate(data.to)}`}</p>

      {/* The answer first, in the words the question was asked in. Colour is
          never the only signal: the label says লাভ or লোকসান in text. */}
      <div className="border-rule mt-3 rounded-md border p-3">
        <p className="text-ink-muted text-xs">
          {profit < 0 ? t('segment.loss', 'লোকসান') : t('segment.profit', 'লাভ')}
        </p>
        <Money
          minor={Math.abs(profit)}
          className={`text-2xl font-semibold ${profit < 0 ? 'text-expense' : 'text-income'}`}
        />
      </div>

      <div className="mt-3">
        <Row label={t('statements.totalIncome', 'মোট আয়')} minor={data.incomeMinor} strong />
        <Nodes nodes={data.income} />
        <Row label={t('statements.totalExpense', 'মোট ব্যয়')} minor={data.expenseMinor} strong />
        <Nodes nodes={data.expenses} />
      </div>

      <p className="text-ink-muted mt-3 text-xs">
        {t(
          'segment.basis',
          'নগদ ভিত্তিতে — টাকা যেদিন হাতবদল হয়েছে সেদিন ধরা হয়েছে। বাকিতে বিক্রি বা বাকিতে কেনা এখানে আসবে না।',
        )}
      </p>
    </section>
  );
}

function Row({ label, minor, strong }: { label: string; minor: number; strong?: boolean }) {
  return (
    <div
      className={`border-rule flex items-baseline justify-between gap-3 border-b py-1.5 last:border-0 ${
        strong ? 'text-ink font-semibold' : 'text-ink'
      }`}
    >
      <span className={`min-w-0 truncate text-sm ${strong ? '' : 'pl-4'}`}>{label}</span>
      <Money minor={minor} className="w-28 shrink-0 text-right text-sm" />
    </div>
  );
}

function Nodes({ nodes }: { nodes: CategoryNode[] }) {
  return (
    <>
      {nodes.map((node) => (
        <Row key={node.categoryId ?? node.name} label={node.name} minor={node.totalMinor} />
      ))}
    </>
  );
}
