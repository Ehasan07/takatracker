'use client';

import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AcceptDraftBody, DraftPage, DraftView, MessagePage, RejectReason } from './types';

/**
 * Fifty is the API's own default and its ceiling is a hundred. A page deep
 * enough to hold a month of bank alerts means the bulk flow almost never has
 * to stop and fetch in the middle of a run.
 */
export const PAGE_SIZE = 50;

/**
 * One key namespace for everything ingestion, so a single
 * `invalidateQueries({ queryKey: ['ingestion'] })` refreshes the inbox and the
 * webhook settings together.
 */
export const inboxKeys = {
  all: ['ingestion'] as const,
  drafts: (status: string) => ['ingestion', 'drafts', status] as const,
  message: (id: string) => ['ingestion', 'message', id] as const,
  messages: () => ['ingestion', 'messages'] as const,
};

function search(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export async function fetchDrafts(params: {
  status: string;
  cursor?: string | null;
}): Promise<DraftPage> {
  const page = await api<DraftPage>(
    `/ingestion/drafts${search({
      status: params.status,
      limit: PAGE_SIZE,
      cursor: params.cursor ?? undefined,
    })}`,
  );
  // A shape guard, not paranoia: an empty page and a broken page must not
  // look the same to a `.map()` further up.
  return { items: page?.items ?? [], nextCursor: page?.nextCursor ?? null };
}

/**
 * Everything this phone has forwarded, whether or not it raised a draft.
 *
 * A separate list from the drafts because it answers a separate question. The
 * drafts list says what needs deciding; this says what arrived — and until it
 * existed, a message that was never about money was stored and then invisible
 * to the person whose phone sent it.
 */
export async function fetchMessages(params: { cursor?: string | null }): Promise<MessagePage> {
  const page = await api<MessagePage>(
    `/ingestion/messages${search({ limit: PAGE_SIZE, cursor: params.cursor ?? undefined })}`,
  );
  return { items: page?.items ?? [], nextCursor: page?.nextCursor ?? null };
}

/** 200, not 201 — the draft comes back with `transactionId` set. */
export function acceptDraft(id: string, body: AcceptDraftBody): Promise<DraftView> {
  return api<DraftView>(`/ingestion/drafts/${id}/accept`, { method: 'POST', body });
}

/** Writes nothing to the ledger. The message stays, so a bad parse can be studied. */
export function rejectDraft(id: string, reason: RejectReason): Promise<DraftView> {
  return api<DraftView>(`/ingestion/drafts/${id}/reject`, {
    method: 'POST',
    body: { reason },
  });
}

/**
 * Accepting a draft is creating a transaction, so everything a new transaction
 * touches is stale — not just the inbox. `entitlements` is in the list because
 * the accept path is metered exactly like the manual one.
 */
export function invalidateAfterAccept(queryClient: QueryClient): void {
  for (const key of [
    ['ingestion'],
    ['transactions'],
    ['accounts'],
    ['reports'],
    ['entitlements'],
    /* An accept can settle a premium, and the বীমা screen would otherwise go on
       showing the instalment as owed until something else refetched it. */
    ['insurance'],
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/** Rejecting touches no money, so only the inbox moves. */
export function invalidateAfterReject(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
}
