'use client';

/**
 * The mailbox.
 *
 * **Why a ledger app reads email at all.** Bank and card statements, bKash and
 * Nagad receipts, utility bills — in Bangladesh they arrive as email far more
 * reliably than as SMS, and they are the raw material a month's ledger is built
 * from. Connecting a mailbox is how those documents get somewhere they can be
 * found, read on a phone, and turned into transactions. That sentence is printed
 * at the top of the screen, not just written here, because a screen that shows
 * somebody their private mail owes them a plain statement of why it has it.
 *
 * **What it is not.** Nothing on this screen writes to the ledger and nothing
 * behind it does either: the sync worker stores messages and stops there. Making
 * a transaction out of one is a person's job, done by hand, from the button in
 * the message sheet. Saying that plainly is better than implying an automation
 * that does not exist.
 *
 * **Nothing here is live.** The worker sweeps on a fifteen-minute interval; a
 * message that arrived a minute ago is very likely not here yet. So there is no
 * spinner suggesting mail is on its way — the empty states say when the mailbox
 * was last read and roughly when it will be read next, which is the true and
 * useful thing.
 *
 * Density and type are deliberately looser than the ledger's. This is somebody's
 * correspondence, not a table of figures.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Mail, Search, Settings, X } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import {
  bnClock,
  bnDate,
  bnNum,
  FOLDER_LABEL,
  FOLDERS,
  lastSyncLine,
  nextSweepLine,
} from './labels';
import { MessageSheet } from './message-sheet';
import { AuthFailedNotice, Chip, QueryError } from './parts';
import { fetchMailAccounts, fetchMailMessages, mailKeys, PAGE_SIZE } from './queries';
import type { MailAccountView, MailFolder, MailMessagePage, MailMessageView } from './types';

export default function MailPage() {
  const [folder, setFolder] = React.useState<MailFolder>('INBOX');
  const [accountId, setAccountId] = React.useState('');
  const [typed, setTyped] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [openId, setOpenId] = React.useState<string | null>(null);

  /* Debounced, so typing "bkash" is one request and not five. 300ms is what the
     tag screen uses; matching it keeps the app's search boxes feeling alike. */
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const accounts = useQuery({
    queryKey: mailKeys.accounts(),
    queryFn: fetchMailAccounts,
    /* A database read, and the only way this screen ever learns that a sweep
       happened — the API says so itself: the client finds out from `lastSyncAt`
       and `lastError` on the next `GET /mail-accounts`. A minute is far cheaper
       than the fifteen-minute sweep it is watching for. */
    refetchInterval: 60_000,
  });

  const messages = useInfiniteQuery({
    queryKey: mailKeys.messages(folder, accountId, query),
    queryFn: ({ pageParam }) =>
      fetchMailMessages({ folder, accountId, q: query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: MailMessagePage) => last.nextCursor,
  });

  const rows = React.useMemo(
    () => (messages.data?.pages ?? []).flatMap((page) => page.items),
    [messages.data],
  );

  const allAccounts = React.useMemo(() => accounts.data ?? [], [accounts.data]);
  const accountsById = React.useMemo(
    () => new Map(allAccounts.map((account) => [account.id, account])),
    [allAccounts],
  );
  const broken = allAccounts.filter((account) => account.status === 'AUTH_FAILED');

  const openIndex = openId === null ? -1 : rows.findIndex((row) => row.id === openId);
  const open = openIndex === -1 ? null : (rows[openIndex] ?? null);

  const onStep = React.useCallback(
    (delta: -1 | 1) => {
      if (openIndex === -1) return;
      const next = rows[openIndex + delta];
      if (!next) return;
      haptic('select');
      setOpenId(next.id);
    },
    [rows, openIndex],
  );

  const closeSheet = React.useCallback(() => setOpenId(null), []);

  const filtered = query !== '' || accountId !== '';
  const clearFilters = (): void => {
    setTyped('');
    setQuery('');
    setAccountId('');
  };

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
      {/* Visible at every width, unlike its siblings' `md:block` headings.
          `/mail` is not in `nav-model.ts`, so the phone title bar cannot name
          this screen and would print the app's fallback instead. When the route
          is added to the nav model this can join the others under `md:block`. */}
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-ink text-xl font-semibold sm:text-2xl">মেইলবক্স</h1>
          <p className="text-ink-muted mt-0.5 max-w-prose text-xs">
            ব্যাংক ও কার্ডের স্টেটমেন্ট, বিকাশ-নগদের রসিদ আর বিলের মেইল এখানে আসে — যাতে সেগুলো দেখে
            খাতায় লেনদেন তোলা যায়। মেইল থেকে নিজে নিজে কিছু যোগ হয় না।
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings">
            <Settings className="h-4 w-4" aria-hidden />
            মেইলবক্স সেটআপ
          </Link>
        </Button>
      </header>

      {/* A stopped mailbox is announced above the list, not only in settings:
          this is the screen somebody stares at wondering where their mail is. */}
      {broken.map((account) => (
        <AuthFailedNotice key={account.id} account={account} />
      ))}

      <div className="chip-strip" role="group" aria-label="ফোল্ডার বেছে নিন">
        {FOLDERS.map(([value, label]) => (
          <Chip
            key={value}
            active={folder === value}
            onClick={() => {
              setOpenId(null);
              setFolder(value);
            }}
          >
            {label}
          </Chip>
        ))}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="relative min-w-0">
          <Search
            className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            maxLength={200}
            type="search"
            autoComplete="off"
            placeholder="বিষয় বা প্রেরক দিয়ে খুঁজুন"
            aria-label="বার্তা খুঁজুন"
            className="ps-9"
          />
          {typed ? (
            <button
              type="button"
              aria-label="খোঁজা বাতিল"
              onClick={() => setTyped('')}
              className="press text-ink-muted absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>

        {/* Only when there is a choice to make. One mailbox needs no filter. */}
        {allAccounts.length > 1 ? (
          <Select
            value={accountId}
            aria-label="কোন মেইলবক্স"
            onChange={(e) => {
              setOpenId(null);
              setAccountId(e.target.value);
            }}
          >
            <option value="">সব মেইলবক্স</option>
            {allAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.email}
              </option>
            ))}
          </Select>
        ) : null}

        {query ? (
          /* What the search actually does, said before somebody concludes it is
             broken. The API matches substrings over subject, sender, recipient
             and the stored snippet — never the body, which has no index that
             could help — and it does not fold Banglish into Bengali the way the
             ledger's own search does. */
          <p className="text-ink-muted text-[11px]">
            বিষয়, প্রেরক, প্রাপক ও শুরুর কয়েক লাইনের মধ্যে খোঁজা হয় — বার্তার পুরো লেখায় নয়।
            বাংলা শব্দ বাংলা অক্ষরেই লিখুন।
          </p>
        ) : null}
      </div>

      {messages.isError ? (
        <QueryError message="বার্তার তালিকা আনা যায়নি।" onRetry={() => void messages.refetch()} />
      ) : messages.isLoading || accounts.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : rows.length === 0 ? (
        accounts.isError ? (
          <QueryError
            message="মেইলবক্সের তালিকা আনা যায়নি, তাই কেন কিছু দেখা যাচ্ছে না তা বলা গেল না।"
            onRetry={() => void accounts.refetch()}
          />
        ) : (
          <EmptyMail
            accounts={allAccounts}
            accountId={accountId}
            folder={folder}
            filtered={filtered}
            onClear={clearFilters}
          />
        )
      ) : (
        <>
          <p className="text-ink-muted text-xs">
            {bnNum(rows.length)}টি বার্তা{messages.hasNextPage ? '+' : ''} · নতুনটি উপরে
          </p>

          <ul className="rounded-card border-rule bg-surface divide-rule min-w-0 divide-y overflow-hidden border">
            {rows.map((row, index) => (
              <li key={row.id}>
                <MessageRow
                  row={row}
                  account={accountsById.get(row.mailAccountId) ?? null}
                  showAccount={allAccounts.length > 1 && accountId === ''}
                  showDate={index === 0 || !sameDay(rows[index - 1], row)}
                  onOpen={() => {
                    haptic('select');
                    setOpenId(row.id);
                  }}
                />
              </li>
            ))}
          </ul>

          {messages.hasNextPage ? (
            <Button
              variant="outline"
              size="block"
              disabled={messages.isFetchingNextPage}
              onClick={() => void messages.fetchNextPage()}
            >
              {messages.isFetchingNextPage ? 'আনা হচ্ছে…' : 'আরও পুরোনো বার্তা'}
            </Button>
          ) : rows.length >= PAGE_SIZE ? (
            <p className="text-ink-muted text-center text-xs">এই ফোল্ডারের সবগুলো দেখানো হয়েছে।</p>
          ) : null}

          <SyncFooter accounts={allAccounts} accountId={accountId} />
        </>
      )}

      <MessageSheet
        row={open}
        account={open ? (accountsById.get(open.mailAccountId) ?? null) : null}
        hasPrev={openIndex > 0}
        hasNext={openIndex > -1 && openIndex < rows.length - 1}
        onStep={onStep}
        onClose={closeSheet}
      />
    </div>
  );
}

/** Two rows on the same calendar day share one date heading. */
function sameDay(a: MailMessageView | undefined, b: MailMessageView): boolean {
  if (!a) return false;
  return a.receivedAt.slice(0, 10) === b.receivedAt.slice(0, 10);
}

function MessageRow({
  row,
  account,
  showAccount,
  showDate,
  onOpen,
}: {
  row: MailMessageView;
  account: MailAccountView | null;
  showAccount: boolean;
  showDate: boolean;
  onOpen: () => void;
}) {
  const unread = !row.isRead;

  return (
    <>
      {showDate ? (
        <p className="bg-greenbar/50 text-ink-muted px-3 py-1 text-[11px] font-medium">
          {bnDate(row.receivedAt)}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onOpen}
        className="press-row hover:bg-greenbar block w-full min-w-0 px-3 py-3 text-left"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className={cn(
              'mt-1.5 h-2 w-2 shrink-0 rounded-full',
              unread ? 'bg-income' : 'bg-transparent',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <p
                className={cn(
                  'text-ink min-w-0 truncate text-sm',
                  unread ? 'font-semibold' : 'font-medium',
                )}
              >
                {row.fromAddress?.trim() || 'প্রেরকের ঠিকানা নেই'}
              </p>
              <span className="text-ink-muted shrink-0 text-[11px]">{bnClock(row.receivedAt)}</span>
            </div>

            <p className={cn('text-ink mt-0.5 truncate text-sm', unread && 'font-medium')}>
              {row.subject?.trim() || 'বিষয় লেখা নেই'}
            </p>

            {/* The snippet is text the API already trimmed to 280 characters.
                Rendered as a text child, exactly like the body — see the note on
                `MessageBody`. Nothing in this feature ever parses mail. */}
            {row.snippet ? (
              <p className="text-ink-muted mt-0.5 line-clamp-2 text-xs leading-5">{row.snippet}</p>
            ) : null}

            {showAccount && account ? (
              <p className="text-ink-muted mt-1 truncate text-[11px]">{account.email}</p>
            ) : null}
          </div>
        </div>
      </button>
    </>
  );
}

/**
 * Why the list is empty — never a blank page.
 *
 * There are four genuinely different reasons and telling them apart is the whole
 * job: no mailbox is connected at all; one is connected but has never been read;
 * it has been read and there is simply nothing in this folder since `syncSince`;
 * or the user's own filter is hiding everything. Only the last of those is the
 * user's doing.
 */
function EmptyMail({
  accounts,
  accountId,
  folder,
  filtered,
  onClear,
}: {
  accounts: MailAccountView[];
  accountId: string;
  folder: MailFolder;
  filtered: boolean;
  onClear: () => void;
}) {
  if (accounts.length === 0) {
    return (
      <div className="rounded-card border-rule border border-dashed p-8 text-center">
        <Mail className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
        <p className="text-ink mt-2">কোনো মেইলবক্স যুক্ত করা হয়নি।</p>
        <p className="text-ink-muted mx-auto mt-1 max-w-sm text-sm">
          ব্যাংক বা কার্ডের স্টেটমেন্ট যে ইমেইলে আসে সেটি যুক্ত করলে সেগুলো এখানে পড়া যাবে। মেইল
          কেবল পড়া হয় — কোনো মেইল পাঠানো হয় না, মুছে ফেলাও হয় না।
        </p>
        <Button className="mt-3" asChild>
          <Link href="/settings">মেইলবক্স যুক্ত করুন</Link>
        </Button>
      </div>
    );
  }

  if (filtered) {
    return (
      <div className="rounded-card border-rule border border-dashed p-8 text-center">
        <p className="text-ink">এই খোঁজে {FOLDER_LABEL[folder]} ফোল্ডারে কিছু পাওয়া যায়নি।</p>
        <p className="text-ink-muted mt-1 text-sm">
          মনে রাখুন, খোঁজা হয় শুধু বিষয়, প্রেরক, প্রাপক ও শুরুর কয়েক লাইনে।
        </p>
        <Button variant="outline" className="mt-3" onClick={onClear}>
          ছাঁকনি সরান
        </Button>
      </div>
    );
  }

  const relevant = accountId ? accounts.filter((account) => account.id === accountId) : accounts;
  const neverSynced = relevant.filter((account) => account.lastSyncAt === null);
  const stopped = relevant.filter((account) => account.status !== 'ACTIVE');

  /* Not one message has ever been fetched from any of these mailboxes. Which is
     the ordinary state for the first fifteen minutes after connecting, and the
     one where an empty list is most easily mistaken for a broken feature. */
  if (neverSynced.length === relevant.length) {
    return (
      <div className="rounded-card border-rule border border-dashed p-8 text-center">
        <p className="text-ink">এই মেইলবক্স এখনো একবারও পড়া হয়নি।</p>
        <p className="text-ink-muted mx-auto mt-1 max-w-sm text-sm">
          মেইল আনা হয় পেছনে চলা একটি কাজের মাধ্যমে, প্রায় ১৫ মিনিট পরপর — তাই সংযোগ দেওয়ার সাথে
          সাথে বার্তা আসে না। প্রথমবার পড়া হয়ে গেলে এখানে দেখা যাবে।
        </p>
        {stopped.length === relevant.length ? (
          <p className="text-expense mt-2 text-sm">
            তবে এই মেইলবক্সের সিঙ্ক এখন বন্ধ আছে — সেটিংসে গিয়ে ঠিক না করলে কিছুই আসবে না।
          </p>
        ) : null}
        <Button variant="outline" className="mt-3" asChild>
          <Link href="/settings">সেটিংসে অবস্থা দেখুন</Link>
        </Button>
      </div>
    );
  }

  /* Read, and there was nothing to bring back. The window is the likely reason,
     so it is named with its date rather than described. */
  const since = relevant
    .map((account) => account.syncSince)
    .filter((value): value is string => Boolean(value))
    .sort()[0];

  return (
    <div className="rounded-card border-rule border border-dashed p-8 text-center">
      <p className="text-ink">{FOLDER_LABEL[folder]} ফোল্ডারে কোনো বার্তা নেই।</p>
      <p className="text-ink-muted mx-auto mt-1 max-w-sm text-sm">
        {since
          ? `${bnDate(since)} তারিখের পর থেকে মেইল আনা হয়, তার আগের কোনো বার্তা কখনোই পড়া হয় না। ওই সময়ের পর এই ফোল্ডারে কিছু আসেনি।`
          : 'পড়া হয়েছে, কিন্তু এই ফোল্ডারে কিছু পাওয়া যায়নি।'}
      </p>
      <p className="text-ink-muted mx-auto mt-2 max-w-sm text-xs">
        {relevant.map((account) => lastSyncLine(account.lastSyncAt)).join(' · ')}
      </p>
      {folder !== 'INBOX' ? (
        <p className="text-ink-muted mt-2 text-xs">
          সব সার্ভারে এই ফোল্ডারটি থাকে না — না থাকলে সেখান থেকে কিছু আনা যায় না।
        </p>
      ) : null}
    </div>
  );
}

/**
 * When the mail on screen was fetched, and when more is due.
 *
 * Under the list rather than over it, and in words rather than as a spinner: the
 * worker is on a fifteen-minute interval and a spinning circle would promise
 * something arriving in the next second. `nextSweepLine` is explicitly
 * approximate — the interval is a server-side environment variable that no
 * endpoint publishes.
 */
function SyncFooter({ accounts, accountId }: { accounts: MailAccountView[]; accountId: string }) {
  /* Mounted-only, because a relative time computed during render hydrates to a
     different string a moment later. Null until the first tick. */
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const relevant = accountId ? accounts.filter((account) => account.id === accountId) : accounts;
  if (relevant.length === 0) return null;

  return (
    <div className="text-ink-muted flex flex-col gap-1 px-1 text-[11px]">
      {relevant.map((account) => {
        const next = nextSweepLine(account.status, account.lastSyncAt, now);
        return (
          <p key={account.id} className="min-w-0 break-words">
            <span className="break-all">{account.email}</span> — {lastSyncLine(account.lastSyncAt)}
            {next ? ` · ${next}` : ''}
          </p>
        );
      })}
    </div>
  );
}
