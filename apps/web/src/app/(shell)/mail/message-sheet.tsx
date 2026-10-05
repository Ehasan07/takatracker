'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { bnDateTime, bnNum, FOLDER_LABEL } from './labels';
import { MessageBody, QueryError } from './parts';
import { fetchMailMessage, mailKeys } from './queries';
import type { MailAccountView, MailMessageView } from './types';

/**
 * Reading one message.
 *
 * A sheet rather than a route, for the same reason the ingestion review is one:
 * the list is the place and the message is the work, and coming back to the
 * pixel you left is worth more here than a shareable URL for somebody's private
 * mail would be.
 *
 * The list rows carry no `body` — the API leaves it out of `GET /mail-messages`
 * on purpose, because forty full bodies is a multi-megabyte response for a
 * screen showing two lines each — so opening a message is a second request. The
 * header below is drawn from the row we already have, so the envelope is on
 * screen instantly and only the text arrives late.
 */
export function MessageSheet({
  row,
  account,
  hasPrev,
  hasNext,
  onStep,
  onClose,
}: {
  row: MailMessageView | null;
  /** The mailbox it arrived in, when it is still in the list. */
  account: MailAccountView | null;
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
}) {
  /* j / k / arrows walk the list the way they do in a mail client, with the same
     guard the app shell puts on its own "n": never while somebody is typing. */
  React.useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        onStep(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        onStep(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row, onStep]);

  return (
    <Sheet
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="বার্তা"
      description={row ? FOLDER_LABEL[row.folder] : undefined}
      className="md:w-[44rem]"
    >
      {row ? (
        <MessageView
          key={row.id}
          row={row}
          account={account}
          hasPrev={hasPrev}
          hasNext={hasNext}
          onStep={onStep}
        />
      ) : null}
    </Sheet>
  );
}

function MessageView({
  row,
  account,
  hasPrev,
  hasNext,
  onStep,
}: {
  row: MailMessageView;
  account: MailAccountView | null;
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: -1 | 1) => void;
}) {
  const detail = useQuery({
    queryKey: mailKeys.message(row.id),
    queryFn: () => fetchMailMessage(row.id),
    /* Mail does not change once it is stored — the worker upserts the same row
       from the same `externalId` — so a body fetched five minutes ago is still
       the body. Nothing here needs to refetch on a window focus. */
    staleTime: 5 * 60_000,
  });

  return (
    <article className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-1.5">
        <h2 className="text-ink min-w-0 break-words text-lg font-semibold leading-snug">
          {row.subject?.trim() || 'বিষয় লেখা নেই'}
        </h2>

        <dl className="text-ink-muted flex min-w-0 flex-col gap-0.5 text-xs">
          <div className="flex min-w-0 gap-1.5">
            <dt className="shrink-0">পাঠিয়েছেন</dt>
            <dd className="text-ink min-w-0 break-all">
              {row.fromAddress ?? 'ঠিকানা জানা যায়নি'}
            </dd>
          </div>
          {row.toAddress ? (
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0">পেয়েছেন</dt>
              <dd className="min-w-0 break-all">{row.toAddress}</dd>
            </div>
          ) : null}
          <div className="flex min-w-0 flex-wrap gap-x-1.5">
            <dt className="shrink-0">তারিখ</dt>
            <dd>{bnDateTime(row.receivedAt)}</dd>
          </div>
          {account ? (
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0">মেইলবক্স</dt>
              <dd className="min-w-0 break-all">{account.email}</dd>
            </div>
          ) : null}
        </dl>
      </header>

      {detail.isError ? (
        <QueryError message="বার্তাটির লেখা আনা যায়নি।" onRetry={() => void detail.refetch()} />
      ) : detail.isLoading ? (
        <div className="border-rule flex flex-col gap-2.5 rounded-md border p-3" aria-hidden>
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ) : (
        <MessageBody body={detail.data?.body ?? null} />
      )}

      {/* What the mailbox is for, at the moment it can actually be acted on.
          The server stores mail; it does not turn mail into drafts — see the
          note on the list screen — so the honest next step is the manual one. */}
      <div className="border-rule bg-greenbar/60 flex flex-col gap-2 rounded-md border border-dashed p-3">
        <p className="text-ink-muted text-xs">
          এই বার্তায় কোনো লেনদেন থাকলে সেটি নিজে খাতায় তুলতে হবে — মেইল থেকে নিজে নিজে কোনো খসড়া
          তৈরি হয় না।
        </p>
        <Button variant="outline" size="sm" className="self-start" asChild>
          <Link href="/?quickadd=1">
            <Plus className="h-4 w-4" aria-hidden />
            খাতায় লেনদেন লিখুন
          </Link>
        </Button>
      </div>

      <div className="bg-surface border-rule sticky bottom-0 -mx-4 flex items-center justify-between gap-2 border-t px-4 pb-2 pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onStep(-1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          আগেরটি
        </Button>
        <span className="text-ink-muted shrink-0 text-[11px]">
          {row.isRead ? 'পড়া হয়েছে' : 'নতুন'}
          {detail.data?.body ? ` · ${bnNum(detail.data.body.length)} অক্ষর` : ''}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasNext}
          onClick={() => onStep(1)}
        >
          পরেরটি
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </article>
  );
}
