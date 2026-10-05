'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Info, Printer } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { StandardNote } from '@/components/info-note';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Field, Input, Select } from '@/components/ui/field';
import { toLocalDateString } from '@hishab/shared';
import { fmtDate } from '@/lib/format';
import { t } from '@/lib/t';
import { Button } from '@/components/ui/button';
import { api, endpoints } from '@/lib/api';
import { fetchTags, tagKeys } from '../../tags/queries';
import { fetchIncomeStatement, reportKeys } from '../queries';
import { SetupCard } from './setup-card';
import { StockCountSheet } from './stock-count-sheet';
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
  const [counting, setCounting] = React.useState(false);
  /* Kept on the page rather than inside `SetupCard`, because the card is gone
     the moment it succeeds — the tag list it was waiting for arrives and the
     empty state stops rendering. A confirmation that unmounts with the thing
     that produced it is a confirmation nobody sees. */
  const [built, setBuilt] = React.useState<{ count: number; name: string } | null>(null);
  /* Open on its own for a workspace with no business categories, and openable
     by hand for ever after — "দুইটা ব্যবসা থাকলে দুইবার, দুই নামে" is what the
     guide says, so the button that does it cannot be a thing that appears once
     and never again. */
  const [setupOpen, setSetupOpen] = React.useState(false);

  const period = React.useMemo(() => ({ from, to }), [from, to]);
  /* The switch that says these books have a business in them. Everything below
     waits on it: a household that never asked for a shop should not be shown
     one because it typed a URL. */
  const workspace = useQuery({
    queryKey: ['workspace', 'settings'],
    queryFn: () => api<{ businessEnabled: boolean }>('/workspace/settings'),
    staleTime: 60_000,
  });
  const enabled = workspace.data?.businessEnabled ?? false;

  const tags = useQuery({
    queryKey: tagKeys.list(''),
    queryFn: () => fetchTags(''),
    enabled,
  });

  /* Whether this workspace has the business category tree, which is the real
     question — and not, as this screen first asked, whether it has any tags at
     all. Almost every workspace has tags: পারিবারিক, রমজান, a trip. Asking the
     wrong question hid the setup card from everybody except a brand-new
     account, so the one press this page exists to offer was unreachable for
     the people most likely to want it. */
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: endpoints.categories,
    enabled,
  });
  const hasTree = (categories.data ?? []).some(
    (category) => category.nameBn === 'ব্যবসার আয়' || category.name === 'Business income',
  );

  /* Nothing is asked for until a venture is chosen. The whole-household answer
     is the statements page and already exists; an unfiltered figure here would
     be the same number under a heading that says শুধু এই ব্যবসার. */
  const statement = useQuery({
    queryKey: reportKeys.incomeStatement(period, undefined, tagId),
    queryFn: () => fetchIncomeStatement(period, undefined, tagId),
    enabled: enabled && tagId !== '',
  });

  const list = tags.data ?? [];

  React.useEffect(() => {
    if (enabled && categories.isSuccess && !hasTree) setSetupOpen(true);
  }, [enabled, categories.isSuccess, hasTree]);

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
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm"
          >
            <Printer className="h-4 w-4" aria-hidden />
            {t('statements.print', 'প্রিন্ট বা PDF')}
          </button>
        ) : null}
      </div>

      <header>
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <h1 className="text-ink text-xl font-extrabold sm:text-2xl">
            {t('segment.title', 'ব্যক্তিগত ব্যবসার হিসাব')}
          </h1>
          <StandardNote noteKey="note.segmentBooks" />
        </div>
        <p className="text-ink-muted text-sm">
          {t('segment.blurb', 'নিজের ব্যাংক-বিকাশ দিয়েই ব্যবসা চললে তার আয়-খরচ আলাদা করে দেখুন')}
        </p>
      </header>

      <div className={`no-print flex flex-col gap-3 ${enabled ? '' : 'hidden'}`}>
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

      {workspace.isSuccess && !enabled ? <NotEnabled /> : null}

      <Guide openByDefault={enabled && categories.isSuccess && !hasTree} />

      {enabled && setupOpen ? (
        <SetupCard
          onDone={(result) => {
            setTagId(result.tagId);
            setBuilt({ count: result.createdCategories, name: result.tagName });
            setSetupOpen(false);
          }}
        />
      ) : null}

      {enabled && !setupOpen ? (
        <div className="no-print">
          <Button variant="outline" onClick={() => setSetupOpen(true)}>
            {t('segment.addAnother', 'নতুন ব্যবসা যোগ করুন')}
          </Button>
        </div>
      ) : null}

      {built ? (
        <p className="text-income no-print text-sm">
          {t(
            'segment.built',
            '{n}টি খাত আর “{name}” ট্যাগ তৈরি হয়েছে — এবার ব্যবসার প্রতিটা আয়-খরচে ট্যাগটা লাগাতে শুরু করুন।',
          )
            .replace('{n}', String(built.count))
            .replace('{name}', built.name)}
        </p>
      ) : null}

      {/* The month-end step, beside the figure it corrects. Offered only once a
          venture is chosen: the entry it writes carries that tag, and a count
          filed against nothing would land on the household's books alone. */}
      {tagId ? (
        <div className="no-print">
          <Button variant="outline" onClick={() => setCounting(true)}>
            {t('segment.count', 'মাস শেষে মজুদ গুনুন')}
          </Button>
        </div>
      ) : null}

      <StockCountSheet open={counting} onOpenChange={setCounting} tagId={tagId} />

      {tagId === '' ? null : statement.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border-[1.5px]">
          <SkeletonRows rows={6} />
        </div>
      ) : statement.data ? (
        <Result data={statement.data} />
      ) : null}
    </div>
  );
}

/**
 * The screen when the workspace has not asked for a business.
 *
 * Not a redirect and not a blank page. Somebody arriving here either followed
 * an old link or is looking for exactly this and has not found the switch —
 * both are answered by saying where the switch is. The guide below stays
 * readable either way: deciding whether to turn it on is a reason to read how
 * it works.
 */
function NotEnabled() {
  return (
    <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
      <h2 className="text-ink text-base font-semibold">
        {t('segment.offTitle', 'এই হিসাবটি চালু করা নেই')}
      </h2>
      <p className="text-ink-muted mt-1 text-sm">
        {t(
          'segment.offBody',
          'দোকান, ছোট ব্যবসা বা শেয়ার-বিনিয়োগ থাকলে সেটিংস থেকে “ব্যক্তিগত ব্যবসা বা শেয়ার ট্রেডিং” চালু করুন। ব্যবসা না থাকলে দরকার নেই — খাতের তালিকা অকারণে বড় হবে।',
        )}
      </p>
      <Link
        href="/settings"
        className="press border-rule text-ink hover:bg-greenbar mt-3 inline-flex min-h-11 items-center rounded-xl border px-3 text-sm"
      >
        {t('segment.offGo', 'সেটিংসে যান')}
      </Link>
    </section>
  );
}

/**
 * How to keep a personal business in here, in full, behind one control.
 *
 * ## Why the whole thing is on this page
 *
 * Somebody who runs a shop out of their own bKash does not have an accounting
 * question, they have a "what do I do" question, and the answer is six steps
 * long. Six steps do not fit in a tooltip and do not survive being split across
 * six ⓘ icons — the reader would have to find them all and put them in order
 * themselves. So the sequence is here, once, and the ⓘ notes beside the figures
 * carry the *rules* it rests on: what a transfer is, why stock is not a cost,
 * why a share purchase is not an expense. Steps here, principles there.
 *
 * ## Open for whoever has never done it
 *
 * A workspace with no tags at all has nothing this page can draw, so the guide
 * is what the page *is* for that person, and it starts open. Everybody else
 * gets the number they came for and a control that says what is behind it.
 *
 * Same disclosure contract as `InfoNote` — a real button, `aria-expanded`,
 * `aria-controls` at a panel that stays in the document — for the same reasons
 * spelled out there.
 */
function Guide({ openByDefault }: { openByDefault: boolean }) {
  const [open, setOpen] = React.useState(false);
  const panelId = `${React.useId()}-guide`;

  /* Follows the answer to "does this workspace tag anything yet", which arrives
     after the first paint. Deliberately one-way: it opens the guide for
     somebody who has nothing, and never closes one the reader opened. */
  React.useEffect(() => {
    if (openByDefault) setOpen(true);
  }, [openByDefault]);

  return (
    <section className="rounded-card border-rule bg-surface no-print border-[1.5px]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
        className="press text-ink hover:bg-greenbar flex min-h-11 w-full items-center gap-2 rounded-xl px-4 py-2 text-left text-sm font-medium"
      >
        <Info className="text-brand h-4 w-4 shrink-0" aria-hidden />
        {t('segment.guide', 'ব্যক্তিগত ব্যবসার হিসাব কীভাবে রাখবেন')}
      </button>

      <div id={panelId} hidden={!open} className="text-ink-muted px-4 pb-4 text-sm">
        <p>
          {t(
            'segment.guideIntro',
            'ব্যবসার জন্য আলাদা ব্যাংক অ্যাকাউন্ট না থাকলেও চলবে। হিসাবের খাতায় মালিক আর ব্যবসা দুইজন আলাদা ব্যক্তি — আইনে এক হলেও। এখানে সেই ভাগটা করে ট্যাগ।',
          )}
        </p>

        <Heading note="note.ownerCapital">{t('segment.guideSetup', 'সেটআপ — একবারের কাজ')}</Heading>
        <Steps
          items={[
            t(
              'segment.step1',
              'ব্যবসার নাম লিখে “তৈরি করে দিন” চাপুন — ট্যাগ আর আঠারোটা খাত (বিক্রি, বিক্রীত পণ্যের ব্যয়, দোকান ভাড়া, বেতন, ব্রোকারেজ) এক চাপেই তৈরি হয়ে যাবে। দুইটা ব্যবসা থাকলে দুইবার, দুই নামে।',
            ),
            t(
              'segment.step2',
              'দোকানের মজুদ, ক্যাশ বাক্স বা শেয়ারের বিও অ্যাকাউন্ট থাকলে সেগুলোকে আলাদা অ্যাকাউন্ট বানান। নিজের ব্যাংক থেকে ওখানে টাকা দিলে সেটা ট্রান্সফার — খরচ নয়।',
            ),
          ]}
        />

        <Heading>{t('segment.guideDaily', 'প্রতিদিনের কাজ')}</Heading>
        <Steps
          items={[
            t(
              'segment.step4',
              'ব্যবসার প্রতিটা আয় আর প্রতিটা খরচে ওই ট্যাগটা লাগান। ব্যক্তিগত খরচে কোনো ট্যাগ লাগবে না।',
            ),
            t(
              'segment.step5',
              'বাকিতে বিক্রি করলে বা বাকিতে কিনলে সেটা ধার পাতায় লিখুন — টাকা হাতে আসার দিনে খাতায় উঠবে।',
            ),
            t(
              'segment.step6',
              'মাস শেষে এই পাতায় এসে ট্যাগ আর তারিখ বেছে নিন। লাভ না লোকসান, উপরেই লেখা থাকবে।',
            ),
          ]}
        />

        <Heading>{t('segment.guideMistakes', 'তিনটা ভুল, যেগুলো সবাই করে')}</Heading>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>
            {t(
              'segment.mistake1',
              'শেয়ার কেনাকে খরচ লেখা। টাকা খরচ হয়নি, রূপ বদলেছে — ব্যাংক থেকে বিনিয়োগে। ট্রান্সফার লিখুন।',
            )}
          </li>
          <li>
            {t(
              'segment.mistake2',
              'মূলধন দেওয়া বা ব্যবসা থেকে টাকা তোলাকে আয়-খরচ লেখা। নিজের এক পকেট থেকে আরেক পকেটে — ট্রান্সফার।',
            )}
          </li>
          <li>
            {t(
              'segment.mistake3',
              'দোকানের মাল কেনাকে সঙ্গে সঙ্গে খরচ লেখা। না বেচা পর্যন্ত ওটা মজুদ, একটা সম্পদ।',
            )}
          </li>
        </ul>

        <Heading note="note.investmentNotExpense">
          {t('segment.guideShares', 'শেয়ার কেনাবেচা')}
        </Heading>
        <dl className="mt-1 space-y-1">
          <Line
            term={t('segment.shareBuy', 'শেয়ার কিনলেন')}
            def={t('segment.shareBuyDef', 'ব্যাংক থেকে বিও অ্যাকাউন্টে ট্রান্সফার')}
          />
          <Line
            term={t('segment.shareFee', 'কমিশন, লাগা, হাওলা')}
            def={t('segment.shareFeeDef', 'ব্রোকারেজ খরচ — ব্যবসার খরচের নিচে')}
          />
          <Line
            term={t('segment.shareSell', 'শেয়ার বেচলেন')}
            def={t(
              'segment.shareSellDef',
              'বিও থেকে ব্যাংকে ট্রান্সফার, আর কেনা দামের সঙ্গে পার্থক্যটুকু আয় (লাভ) বা খরচ (লোকসান)',
            )}
          />
          <Line
            term={t('segment.shareDiv', 'লভ্যাংশ পেলেন')}
            def={t(
              'segment.shareDivDef',
              'আয়। উৎসে কর কাটলে মোট অঙ্কটা আয়ে, কাটা করটা আলাদা খরচে',
            )}
          />
          <Line
            term={t('segment.shareUp', 'বাজারদর বাড়ল')}
            def={t(
              'segment.shareUpDef',
              'আয় নয়। সম্পদ পাতা থেকে পুনর্মূল্যায়ন করুন — নিট সম্পদ বাড়বে, আয় বাড়বে না',
            )}
          />
          <Line
            term={t('segment.shareBonus', 'বোনাস শেয়ার')}
            def={t('segment.shareBonusDef', 'কোনো এন্ট্রি নাই — শেয়ার বেড়েছে, টাকা যায়নি')}
          />
        </dl>

        <Heading note="note.stockNotExpense">
          {t('segment.guideShop', 'দোকান বা মুদির ব্যবসা')}
        </Heading>
        <p className="mt-1">
          {t(
            'segment.shopBody',
            'মাল কিনলে মজুদ অ্যাকাউন্টে যোগ করুন। মাস শেষে একদিন মাল গুনে এক লাইনের সমন্বয় দিন — খোলা মজুদ + মাসের ক্রয় − সমাপনী মজুদ = বিক্রীত পণ্যের ব্যয়। ওই এক লাইনেই মাসের লাভটা সত্যি হয়। প্রতিটা বিক্রিতে ব্যয় ধরার দরকার নাই।',
          )}
        </p>

        <p className="mt-3">
          {t(
            'segment.guideLimit',
            'একটা সীমা জেনে রাখুন — এই হিসাব নগদ ভিত্তিতে। টাকা যেদিন হাতবদল হলো সেদিনই ধরা হয়। বাকিতে বিক্রি বা বাকিতে কেনা এখানে আসবে না; ওগুলো ধার পাতায় রাখুন।',
          )}
        </p>
      </div>
    </section>
  );
}

/**
 * A section of the guide, with the rule it rests on behind a ⓘ beside it.
 *
 * The steps say what to do; the note says under what standard, for whoever
 * wants to check rather than take it on trust. One icon per heading and never a
 * row of them: three identical ⓘ side by side name three different things to a
 * screen reader and nothing at all to everybody else.
 *
 * `flex flex-wrap items-baseline` is the contract `InfoNote` documents — the
 * trigger flows after the text and the opened note drops to its own line.
 */
function Heading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-1.5">
      <h3 className="text-ink text-sm font-semibold">{children}</h3>
      {note ? <StandardNote noteKey={note} /> : null}
    </div>
  );
}

/** Numbered because the order is the instruction, not decoration. */
function Steps({ items }: { items: readonly string[] }) {
  return (
    <ol className="mt-1 list-decimal space-y-1 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

function Line({ term, def }: { term: string; def: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-ink font-medium">{term} —</dt>
      <dd className="min-w-0">{def}</dd>
    </div>
  );
}

function Result({ data }: { data: IncomeStatementDto }) {
  const profit = data.surplusMinor;
  const traded = data.incomeMinor !== 0 || data.expenseMinor !== 0;

  if (!traded) {
    return (
      <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
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
    <section className="rounded-card border-rule bg-surface loan-print-block border-[1.5px] p-4">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <h2 className="text-ink text-base font-semibold">
          {data.segment?.name ?? t('segment.title', 'ব্যক্তিগত ব্যবসার হিসাব')}
        </h2>
        <StandardNote noteKey="note.cashBasis" />
      </div>
      <p className="text-ink-muted text-xs">{`${fmtDate(data.from)} — ${fmtDate(data.to)}`}</p>

      {/* The answer first, in the words the question was asked in. Colour is
          never the only signal: the label says লাভ or লোকসান in text. */}
      <div className="border-rule mt-3 rounded-xl border p-3">
        <p className="text-ink-muted text-xs">
          {profit < 0 ? t('segment.loss', 'লোকসান') : t('segment.profit', 'লাভ')}
        </p>
        <Money
          minor={Math.abs(profit)}
          className={`text-2xl font-extrabold ${profit < 0 ? 'text-expense' : 'text-income'}`}
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
    /* Minimum width, not width, and the row wraps rather than spills — see the
       note on the statements page's own `Row`. */
    <div
      className={`border-rule flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b py-1.5 last:border-0 ${
        strong ? 'text-ink font-semibold' : 'text-ink'
      }`}
    >
      <span className={`min-w-0 flex-1 truncate text-sm ${strong ? '' : 'pl-4'}`}>{label}</span>
      <Money minor={minor} className="ml-auto min-w-20 whitespace-nowrap text-right text-sm" />
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
