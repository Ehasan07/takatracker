'use client';

import { api } from '@/lib/api';
import type { MailAccountView, MailMessageDetailView, MailMessagePage } from './types';

/**
 * The API's own default is 50 and its ceiling is 100. Forty is a deliberate step
 * down from the ingestion inbox's fifty: that screen is a work queue somebody
 * runs through in one sitting, this one is a mailbox somebody browses, and a
 * shorter first page reaches the screen faster on a phone.
 */
export const PAGE_SIZE = 40;

/**
 * One namespace for everything mail, so a single
 * `invalidateQueries({ queryKey: ['mail'] })` refreshes the reading screen and
 * the settings card together — they are two views of the same rows and must not
 * disagree after a sync or a disconnect.
 */
export const mailKeys = {
  all: ['mail'] as const,
  accounts: () => ['mail', 'accounts'] as const,
  messages: (folder: string, accountId: string, q: string) =>
    ['mail', 'messages', folder, accountId, q] as const,
  message: (id: string) => ['mail', 'message', id] as const,
};

function search(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export async function fetchMailAccounts(): Promise<MailAccountView[]> {
  const page = await api<{ items: MailAccountView[] }>('/mail-accounts');
  return page?.items ?? [];
}

export async function fetchMailMessages(params: {
  folder: string;
  accountId: string;
  q: string;
  cursor?: string | null;
}): Promise<MailMessagePage> {
  const page = await api<MailMessagePage>(
    `/mail-messages${search({
      folder: params.folder,
      accountId: params.accountId,
      q: params.q,
      limit: PAGE_SIZE,
      cursor: params.cursor ?? undefined,
    })}`,
  );
  // A shape guard, not paranoia: an empty page and a broken page must not look
  // the same to a `.map()` further up.
  return { items: page?.items ?? [], nextCursor: page?.nextCursor ?? null };
}

/** The only call that returns `body`. The list deliberately does not carry it. */
export function fetchMailMessage(id: string): Promise<MailMessageDetailView> {
  return api<MailMessageDetailView>(`/mail-messages/${id}`);
}
