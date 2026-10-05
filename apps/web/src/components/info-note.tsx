'use client';

import { Info } from '@/components/icons';
import * as React from 'react';
import { t } from '@/lib/t';

/**
 * A ⓘ that opens one short note.
 *
 * ## Why a disclosure and not a tooltip
 *
 * The statements state things a reader has to take on trust — "cash basis",
 * "revaluation goes to equity" — and never say why. The reference that answers
 * it is worth having, and worth nothing to most people looking at the page,
 * which is exactly the shape a disclosure is for: one small icon for everybody,
 * the paragraph only for whoever asks.
 *
 * A tooltip would have been the smaller change and is the wrong control. A
 * tooltip is hover, and hover does not exist on the phone this app is mostly
 * read on; the ones that do work on touch cannot be read at leisure, cannot
 * hold two sentences, and turn dismissal into a problem. This is a button.
 *
 * ## The accessibility, spelled out because it is the whole point
 *
 * - A real `<button type="button">`. Not a `<div onClick>`, not a `<summary>`
 *   dressed up as one — Tab reaches it, Enter and Space press it, and assistive
 *   technology calls it a button without being told to.
 * - `aria-expanded` on the button, `aria-controls` pointing at the panel, so
 *   the state is announced and not merely drawn.
 * - The panel stays in the document and is toggled with the `hidden`
 *   attribute, so `aria-controls` always resolves to a real element. A panel
 *   that is unmounted on close leaves that attribute pointing at nothing.
 * - The accessible name says which note it is — "নগদ ভিত্তি — কেন এভাবে দেখানো
 *   হয়" — because a page carrying seven of these must not offer seven controls
 *   all called the same thing. The icon is `aria-hidden`: decoration on top of
 *   a name, never the name itself.
 * - 44px through `.touch-target`, the same `--hishab-touch-min` every other tap
 *   target on the screen uses.
 *
 * ## Why the root is a fragment, and what the call site owes it
 *
 * The trigger has to sit beside the heading it annotates; the note has to be as
 * wide as the card, or it becomes a column of two-word lines on a 320px phone.
 * Those are two different places in the layout, so this renders **two
 * siblings** — the button and a `basis-full` panel — rather than wrapping them
 * in a box that would have to be one or the other.
 *
 * The contract that makes it work, and the only thing a caller must remember:
 * **the parent must be `flex flex-wrap items-baseline`.** The button then flows
 * after the heading, and the panel, being full-basis, drops to its own line
 * across the whole width. Nothing is positioned absolutely, so nothing can be
 * clipped by a card, and nothing can push the page sideways at any width.
 *
 * ## Why the state is local
 *
 * Each note opens and closes on its own. An accordion — where opening one shuts
 * the last — is the wrong model for footnotes: somebody comparing the cash-flow
 * note against the revaluation note wants both, and closing one behind their
 * back reads as a bug.
 */
export function InfoNote({
  label,
  body,
  standard,
}: {
  /** What the note is about, translated. Becomes the button's accessible name. */
  label: string;
  /** The note itself, in plain Bengali, translated. */
  body: string;
  /** The reference, verbatim: `IAS 1.27`. Printed last, never translated. */
  standard: string;
}) {
  const [open, setOpen] = React.useState(false);
  /* `useId` and not a slug of the label: two panels on one page could
     legitimately carry the same note, and duplicate ids would make both
     buttons' `aria-controls` resolve to whichever came first. */
  const panelId = `${React.useId()}-note`;

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${label} — ${t('note.why', 'কেন এভাবে দেখানো হয়')}`}
        onClick={() => setOpen((was) => !was)}
        /* `-my-2` claws back the height the 44px target adds, so a row of text
           with a note in it is not taller than the same row without one. The
           target itself is untouched — it is the margin that shrinks, not the
           button. */
        className="press touch-target text-ink-muted hover:text-ink hover:bg-greenbar -my-2 inline-flex shrink-0 items-center justify-center rounded-xl"
      >
        <Info className="h-4 w-4" aria-hidden />
      </button>

      {/* `basis-full` is what puts this on its own line at the card's full
          width; `hidden` is what keeps `aria-controls` honest when closed. */}
      <p
        id={panelId}
        hidden={!open}
        className="border-brand/40 text-ink-muted basis-full border-l-2 pl-2 text-xs font-normal leading-relaxed"
      >
        {body}{' '}
        {/* Last, and set apart, because it is the citation rather than the
            explanation: somebody checking it should find it at a glance, and
            somebody who is not should be able to stop reading before it. Never
            translated — a standard's number is its name. */}
        <span className="whitespace-nowrap opacity-80">— {standard}</span>
      </p>
    </>
  );
}

/* ---------------------------------------------------------------------------
 * The accounting notes
 *
 * Why the catalogue lives beside the component rather than inside the screen
 * that renders it: every row below is a claim about what this codebase actually
 * does, printed next to a figure somebody may act on, and a false one is worse
 * than no note at all — it invites a reader to check a number against a rule
 * the code does not follow. One table means one file to re-read when the
 * accounting changes, and one file for `info-note.test.ts` to hold to its
 * promises. Scattered through a page of JSX they would rot in silence.
 *
 * Each was verified against the code before it was written, and the file that
 * makes it true is named above it. Do not add a row without doing the same.
 * ------------------------------------------------------------------------- */

export interface AccountingNote {
  /** Stem for the two translation keys: `<key>.label` and `<key>.body`. */
  key: string;
  /** Bengali fallback for the button's accessible name. */
  label: string;
  /** Bengali fallback for the note. Plain language; no accountant assumed. */
  body: string;
  /** The reference, exactly as it is cited. */
  standard: string;
}

export const ACCOUNTING_NOTES: readonly AccountingNote[] = [
  {
    /* True of: `BASIS = 'CASH'` at `reports.service.ts:53`, carried on all four
       statement responses — `:619` balance sheet, `:806` cash flow, `:968`
       income, `:1050` changes in net worth — from that one constant, so a
       second basis could only ever be added in one place. */
    key: 'note.cashBasis',
    label: 'নগদ ভিত্তি',
    body: 'টাকা যেদিন হাতবদল হয়েছে, সেদিনই হিসাবে উঠেছে। যে বিল এখনো দেওয়া হয়নি, সেটা এখানে নেই। চারটি বিবরণীই একই ভিত্তিতে তৈরি, আর প্রতিটি উত্তরের সঙ্গে ভিত্তিটা লেখা যায় — কাউকে অনুমান করতে হয় না।',
    standard: 'IAS 1.27',
  },
  {
    /* True of: `isCurrent()` at `packages/core/src/reports.ts:124` and the four
       totals built from it, rendered on this page as চলতি and অচলতি. */
    key: 'note.currentSplit',
    label: 'চলতি ও অচলতি',
    body: 'এক বছরের মধ্যে যা নগদ হয়ে যায় — হাতের টাকা, ব্যাংক, মোবাইল ওয়ালেট, কারো কাছে পাওনা — আর যা যায় না — জমি, স্বর্ণ, গাড়ি, মেয়াদি ডিপিএস — দুটো আলাদা করে দেখানো হয়। দশ লাখ টাকার জমি আর তিন হাজার টাকার নগদ এক করে ফেললে যোগফলটা ঠিক থাকে, কিন্তু "হাতে কত আছে" প্রশ্নের উত্তর হারিয়ে যায়।',
    standard: 'IAS 1.60',
  },
  {
    /* True of: `cashFlowSection(counterType, systemRole)` at
       `packages/core/src/cash-flow-sections.ts:56` — the switch is on the
       counter account's type, never on `TransactionType`. */
    key: 'note.cashFlowSections',
    label: 'তিন ভাগে নগদ প্রবাহ',
    body: 'নগদ প্রবাহ তিন ভাগে — পরিচালন, বিনিয়োগ, অর্থায়ন। কোন ভাগে পড়বে তা ঠিক হয় টাকাটা উল্টো দিকে কোন ধরনের অ্যাকাউন্টে গেল সেটা দেখে, লেনদেনের নাম দেখে নয়। তাই জমি কিনলে বিনিয়োগ আর কার্ডের বিল শোধ করলে অর্থায়ন, যদিও দুটোই "স্থানান্তর"।',
    standard: 'IAS 7.10',
  },
  {
    /* True of: `TransactionsService.revalue` at `transactions.service.ts:794` —
       the entry is the account against the system equity account, and the
       method refuses liquid accounts, so it reaches neither income nor the cash
       flow statement. */
    key: 'note.revaluationEquity',
    label: 'পুনর্মূল্যায়ন',
    body: 'জমি বা স্বর্ণের দাম বাড়লে সেটা আয় নয় — কেউ আপনাকে টাকা দেয়নি। তাই পুনর্মূল্যায়ন সরাসরি নিট সম্পদে বসে, আয়-ব্যয় বিবরণীতে নয়। নগদও নড়ে না, তাই নগদ প্রবাহেও এটি আসে না।',
    standard: 'IAS 16.39',
  },
  {
    /* True of: `groupAssets()` at `packages/core/src/reports.ts:207`, which
       folds `type === 'ASSET'` rows into `AssetKind` — PROPERTY, VEHICLE, GOLD,
       INVESTMENT, OTHER — and travels on every balance sheet as `assetGroups`.
       The grouped view is drawn on the সম্পদ screen; here each stands as its
       own line. */
    key: 'note.assetsApart',
    label: 'সম্পদের ধরন',
    body: 'জমি-বাড়ি-গাড়ি আর শেয়ার-বিনিয়োগ আলাদা করে ধরা হয়, এক পাল্লায় মেশানো হয় না — দুটোর দাম দুই কারণে বদলায় আর দুই রকম প্রশ্নের উত্তর দেয়। ধরন অনুযায়ী ভাগ করা তালিকাটি "সম্পদ" পাতায়।',
    standard: 'IAS 1.54',
  },
  {
    /* True of: nothing anywhere computes depreciation, and
       `BALANCE_SHEET_NOTES` at `reports.service.ts:76` says so on every balance
       sheet response. A deliberate omission, on the record in
       docs/ACCOUNTING-AUDIT.md §3. */
    key: 'note.noDepreciation',
    label: 'অবচয়',
    body: 'ঘরের গাড়ি বা আসবাবের অবচয় (depreciation) এখানে হিসাব করা হয় না — ইচ্ছে করেই। ব্যক্তিগত হিসাবে ওটা একটা বানানো সংখ্যা, কেউ যাচাই করতে পারে না। দাম বদলালে বরং বাজারদরে পুনর্মূল্যায়ন করা হয়, যেটা সত্যির কাছাকাছি।',
    standard: 'IAS 16.43',
  },
  {
    /* True of: `ReportsService.incomeStatement(ctx, period, compareTo, tagId)`
       at `reports.service.ts:1595` and the `tags: { some: { tagId } }` filter it
       threads into `byCategory` — the segment is a tag on each row, never a set
       of accounts, because the wallet the shop runs on is the household's own. */
    key: 'note.segmentBooks',
    label: 'ব্যবসা আলাদা করে দেখা',
    body: 'ব্যবসার নিজের ব্যাংক অ্যাকাউন্ট না থাকলেও তার হিসাব আলাদা রাখা যায় — মালিক আর ব্যবসাকে হিসাবের খাতায় দুইজন ধরা হয়, আইনে এক হলেও। এখানে সেই ভাগটা করে ট্যাগ: ব্যবসার প্রতিটি আয় ও খরচে একই ট্যাগ লাগালে এই পাতা শুধু ওইটুকুর লাভ-লোকসান বের করে, আর সংসারের বিবরণী আগের মতোই পুরোটা দেখায়।',
    standard: 'IFRS 8.5',
  },
  {
    /* True of: nothing here books a transfer to income or expense — a transfer
       has no category at all (`transactions.service.ts` expands TRANSFER into
       two account legs), so money moved from a personal account into a shop's
       cash box cannot reach the income statement even by accident. */
    key: 'note.ownerCapital',
    label: 'মূলধন ও উত্তোলন',
    body: 'ব্যবসায় নিজের টাকা ঢাললেন, বা ব্যবসার টাকা নিজের সংসারে তুললেন — কোনোটাই আয় বা খরচ নয়। নিজের এক পকেট থেকে আরেক পকেটে গেল, ব্যবসা তাতে কিছু আয়ও করেনি, খরচও করেনি। এগুলো ট্রান্সফার হিসেবে লিখুন; ট্রান্সফারে কোনো খাত লাগে না বলেই ভুলে আয়ের ঘরে ওঠার উপায় নেই।',
    standard: 'IAS 1.109',
  },
  {
    /* True of: an ASSET account holds the stock and nothing computes cost of
       goods sold automatically — the periodic adjustment is a transaction the
       owner records, which is what this note tells them to do. Stated as their
       step, not as the app's, on purpose. */
    key: 'note.stockNotExpense',
    label: 'দোকানের মাল',
    body: 'দোকানের জন্য মাল কেনা মানেই খরচ নয় — না বেচা পর্যন্ত ওটা আপনার মজুদ, একটা সম্পদ। খরচ হয় বিক্রির সময়। ছোট দোকানে সহজ পথ: মাস শেষে একদিন মাল গুনে এক লাইনের সমন্বয় — খোলা মজুদ + মাসের ক্রয় − সমাপনী মজুদ = বিক্রীত পণ্যের ব্যয়। তাহলেই মাসের লাভটা সত্যি হয়।',
    standard: 'IAS 2.34',
  },
  {
    /* True of: `AssetKind.INVESTMENT` on `Account`, plus `revalue` (to equity)
       and `sell` (difference to income) at `transactions.service.ts:794` and
       `:889`. Buying is a transfer between two of the owner's own accounts, so
       it never touches a category. */
    key: 'note.investmentNotExpense',
    label: 'শেয়ার কেনা',
    body: 'শেয়ার কেনা খরচ নয় — টাকা খরচ হয়নি, রূপ বদলেছে: ব্যাংক থেকে বিনিয়োগে। তাই ব্যাংক থেকে বিও অ্যাকাউন্টে ট্রান্সফার লিখুন, খরচ নয়। ব্রোকারেজ কমিশনটুকু আলাদা খরচ। লাভ বা লোকসান ধরা হয় বেচার দিনে — বিক্রির টাকা আর কেনা দামের পার্থক্যটুকুই। বাজারদর বাড়লে সেটা আয় নয়, পুনর্মূল্যায়ন।',
    standard: 'IFRS 9.5.1.1',
  },
  {
    /* True of: `TransactionsService.sell` at `transactions.service.ts:889` —
       three legs, with the gain credited to the income nominal or the loss
       debited to the expense nominal, and only the difference against the
       carrying amount ever reaching either. */
    key: 'note.disposalGain',
    label: 'বিক্রির লাভ',
    body: 'বিক্রি করলে হিসাবটা উল্টো। বিক্রির টাকা আর খাতায় লেখা দামের পার্থক্যই আসল লাভ বা লোকসান, আর সেটা আয়-ব্যয় বিবরণীতে ওঠে — পুনর্মূল্যায়নের মতো নিট সম্পদে বসে থাকে না। আগে যতটুকু পুনর্মূল্যায়ন হয়েছিল, সেটুকু দ্বিতীয়বার আয় হিসেবে গোনা হয় না।',
    standard: 'IAS 16.68',
  },
];

/** Looked up by key, so a call site names the note it wants and fails loudly. */
export function accountingNote(key: string): AccountingNote {
  const found = ACCOUNTING_NOTES.find((note) => note.key === key);
  if (!found) throw new Error(`No accounting note named ${key}`);
  return found;
}

/**
 * One catalogued note, ready to render. Same flex-wrap contract as `InfoNote`.
 *
 * The two strings go through `t()` here rather than at each call site, for the
 * reason `nav-model.ts` resolves its labels through `labelOf`: the catalogue is
 * a module-level constant, so calling `t()` inside it would freeze the language
 * at import time — before `LocaleSync` has said which one the workspace reads.
 */
export function StandardNote({ noteKey }: { noteKey: string }) {
  const note = accountingNote(noteKey);
  return (
    <InfoNote
      label={t(`${note.key}.label`, note.label)}
      body={t(`${note.key}.body`, note.body)}
      standard={note.standard}
    />
  );
}
