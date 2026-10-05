'use client';

/**
 * Connecting mailboxes.
 *
 * Mounted from the settings page as `<MailSettings />` — no props, no wiring.
 *
 * It reads its types, its Bengali labels and its `AuthFailedNotice` from
 * `@/app/(shell)/mail`, rather than keeping private copies the way
 * `ingestion-settings.tsx` does. The reason is specific rather than general:
 * these two screens describe *the same account rows*, and a mailbox that this
 * card calls "সিঙ্ক বন্ধ" while the reading screen calls it something else is a
 * user who does not know whether their mail is coming. One vocabulary, one file.
 * `app-shell.tsx` already imports `useIsOperator` from a feature folder for the
 * same kind of reason.
 *
 * Four things this card exists to get right:
 *
 *  1. **Credentials are verified before anything is stored**, by the API, over
 *     the real network. So connecting is slow, it can fail, and the failure is
 *     specific — wrong password, no IMAP on the account, host unreachable, a
 *     provider we cannot speak to at all. Each of those gets its own sentence,
 *     because "could not connect" would send somebody to reset a password that
 *     was never the problem.
 *  2. **`AUTH_FAILED` means syncing has stopped and will not restart by
 *     itself.** See `AuthFailedNotice`.
 *  3. **Microsoft addresses cannot work**, and the person should learn that
 *     before they go and find their password, not after.
 *  4. **Disconnecting deletes every message that mailbox synced.** `MailMessage`
 *     has no soft delete; the alternative was keeping somebody's private mail
 *     forever with no way to remove it. The confirmation says the number out
 *     loud, before the button, and the receipt says it again after.
 *
 * The password field is never pre-filled, is never returned by the API, and is
 * never persisted anywhere by this file — including the offline queue, which is
 * why no mutation here passes `queueWhenOffline`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Info,
  KeyRound,
  Mail,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { t } from '@/lib/t';
import {
  bnDate,
  bnNum,
  bnSeconds,
  lastSyncLine,
  nextSweepLine,
  SWEEP_MINUTES,
} from '@/app/(shell)/mail/labels';
import { AuthFailedNotice, StatusPill, Toast } from '@/app/(shell)/mail/parts';
import { fetchMailAccounts, mailKeys } from '@/app/(shell)/mail/queries';
import type { MailAccountView } from '@/app/(shell)/mail/types';
import { ApiError, api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { Skeleton } from './skeleton';
import { Button } from './ui/button';
import { Field, Input } from './ui/field';
import { Sheet } from './ui/sheet';

/** 993 is IMAP-over-TLS, which is what all but a handful of hosts use. */
const DEFAULT_PORT = '993';

/**
 * Microsoft-hosted mail, refused before a password is typed.
 *
 * A deliberate copy of `MICROSOFT_DOMAINS` / `MICROSOFT_HOSTS` in
 * `apps/api/src/mail-accounts/mail-accounts.service.ts`. The server is the
 * authority and answers 422 with its own sentence; this copy exists only so the
 * refusal can arrive *before* somebody goes off to find a password that cannot
 * work. If the two lists drift, the server still refuses — the cost of drift is
 * a late explanation, never a wrong one.
 */
const MICROSOFT_DOMAINS = [
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'passport.com',
  'windowslive.com',
];

const MICROSOFT_HOSTS = [
  'outlook.office365.com',
  'outlook.office.com',
  'imap-mail.outlook.com',
  'imap.outlook.com',
  'outlook.com',
];

/** Suffix match on a dot boundary — `includes` would refuse `mail.notlive.com.bd`. */
function matchesSuffix(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value === needle || value.endsWith(`.${needle}`));
}

function isMicrosoftMailbox(email: string, host: string): boolean {
  const domain = email.split('@').pop()?.trim().toLowerCase() ?? '';
  if (domain && matchesSuffix(domain, MICROSOFT_DOMAINS)) return true;
  const hostname = host.trim().toLowerCase().replace(/\.$/, '');
  return hostname !== '' && matchesSuffix(hostname, MICROSOFT_HOSTS);
}

/**
 * The IMAP host for the addresses people here actually have.
 *
 * Only ever a suggestion with a button on it — never filled in silently. A
 * wrong guess that the user cannot see is a connection failure they cannot
 * explain.
 */
const HOST_GUESS: Record<string, string> = {
  'gmail.com': 'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'yahoo.com': 'imap.mail.yahoo.com',
  'icloud.com': 'imap.mail.me.com',
  'me.com': 'imap.mail.me.com',
  'zoho.com': 'imap.zoho.com',
};

/** Providers that will not accept the password somebody logs in with. */
const APP_PASSWORD_DOMAINS = ['gmail.com', 'googlemail.com', 'yahoo.com', 'icloud.com', 'me.com'];

function domainOf(email: string): string {
  return email.split('@').pop()?.trim().toLowerCase() ?? '';
}

/** Bengali for whatever went wrong, whoever it came from. */
function messageFor(err: unknown): string {
  // ApiError already carries the server's own Bengali sentence, and
  // FeatureLimitError extends it, so a plan limit lands here too.
  return err instanceof ApiError ? err.message : t('mail.actionFailed', 'কাজটি করা গেল না');
}

/**
 * 422 is not a validation failure and must not be painted as one.
 *
 * The API answers 422 for exactly one thing: a Microsoft mailbox, which cannot
 * authenticate over IMAP because Microsoft removed the mechanism. Nothing the
 * person typed is wrong. So it is separated out here and rendered as an
 * explanation rather than as a red error under a field.
 */
function isExplanation(err: unknown): boolean {
  return err instanceof ApiError && err.status === 422;
}

export function MailSettings() {
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = React.useState(false);
  const [repairing, setRepairing] = React.useState<MailAccountView | null>(null);
  const [removing, setRemoving] = React.useState<MailAccountView | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  const accounts = useQuery({
    queryKey: mailKeys.accounts(),
    queryFn: fetchMailAccounts,
    /* The only way this card learns that a sweep ran, succeeded or failed — the
       API has no push and says so: the outcome shows up as `lastSyncAt` and
       `lastError` on the next list. */
    refetchInterval: 60_000,
  });

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: mailKeys.all });
  }, [queryClient]);

  const rows = accounts.data ?? [];

  return (
    <section className="rounded-card border-rule bg-surface min-w-0 border-[1.5px] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-ink text-lg font-bold">{t('mail.title', 'ইমেইল থেকে স্টেটমেন্ট')}</h2>
        <Link href="/mail" className="text-income inline-flex items-center gap-1 text-xs">
          <Mail className="h-3.5 w-3.5" aria-hidden />
          মেইলবক্স দেখুন
        </Link>
      </div>

      <p className="text-ink-muted mt-1 text-sm">
        ব্যাংক ও কার্ডের স্টেটমেন্ট, বিকাশ-নগদের রসিদ আর বিলের মেইল এখানে আনা হয়, যাতে সেগুলো দেখে
        খাতায় লেনদেন তোলা যায়। মেইল শুধু <strong>পড়া</strong> হয় — কোনো মেইল পাঠানো হয় না,
        আপনার মেইলবক্স থেকে কিছু মুছেও ফেলা হয় না। মেইল থেকে নিজে নিজে কোনো লেনদেনও যোগ হয় না।
      </p>

      <p className="text-ink-muted mt-2 text-xs">
        মেইল আনা হয় পেছনে চলা একটি কাজের মাধ্যমে, প্রায় {bnNum(SWEEP_MINUTES)} মিনিট পরপর — তাই
        নতুন মেইল সাথে সাথে দেখা যাবে না।
      </p>

      {accounts.isError ? (
        <div
          role="alert"
          className="border-rule mt-3 rounded-xl border border-dashed p-4 text-center"
        >
          <TriangleAlert className="text-expense mx-auto h-5 w-5" aria-hidden />
          <p className="text-ink mt-1 text-sm">
            {t('mail.listFailed', 'যুক্ত করা মেইলবক্সের তালিকা আনা যায়নি।')}
          </p>
          <p className="text-ink-muted text-xs">ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void accounts.refetch()}
          >
            <RotateCw className="h-4 w-4" aria-hidden />
            আবার চেষ্টা করুন
          </Button>
        </div>
      ) : accounts.isLoading ? (
        <div className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-11 w-48" />
        </div>
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="border-rule text-ink-muted mt-4 rounded-xl border border-dashed p-4 text-sm">
              এখনো কোনো মেইলবক্স যুক্ত করা হয়নি।
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-3">
              {rows.map((account) => (
                <li key={account.id}>
                  <AccountCard
                    account={account}
                    onRepair={() => setRepairing(account)}
                    onRemove={() => setRemoving(account)}
                    onDone={(message) => {
                      setToast(message);
                      invalidate();
                    }}
                  />
                </li>
              ))}
            </ul>
          )}

          <Button className="mt-4" onClick={() => setConnecting(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            মেইলবক্স যুক্ত করুন
          </Button>
        </>
      )}

      <ConnectSheet
        open={connecting}
        onOpenChange={setConnecting}
        onConnected={(account) => {
          setConnecting(false);
          setToast(
            `${account.email} যুক্ত হয়েছে। প্রথমবার মেইল পড়তে কিছুক্ষণ সময় লাগবে — প্রায় ${bnNum(SWEEP_MINUTES)} মিনিটের মধ্যে।`,
          );
          invalidate();
        }}
      />

      <PasswordSheet
        account={repairing}
        onClose={() => setRepairing(null)}
        onSaved={(account) => {
          setRepairing(null);
          setToast(`${account.email} — পাসওয়ার্ড যাচাই হয়েছে, সিঙ্ক আবার চালু হয়েছে।`);
          invalidate();
        }}
      />

      <DisconnectSheet
        account={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(email, messagesRemoved) => {
          setRemoving(null);
          setToast(
            messagesRemoved > 0
              ? `${email} সরিয়ে ফেলা হয়েছে। এই মেইলবক্স থেকে আনা ${bnNum(messagesRemoved)}টি বার্তা মুছে ফেলা হয়েছে।`
              : `${email} সরিয়ে ফেলা হয়েছে। মুছে ফেলার মতো কোনো বার্তা ছিল না।`,
          );
          invalidate();
        }}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </section>
  );
}

/* ---------------------------------------------------------------------------
   One mailbox
   --------------------------------------------------------------------------- */

function AccountCard({
  account,
  onRepair,
  onRemove,
  onDone,
}: {
  account: MailAccountView;
  onRepair: () => void;
  onRemove: () => void;
  onDone: (message: string) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);

  /* Mounted-only clock. A relative time computed during render hydrates to a
     different string a second later, and React is right to complain. */
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const sync = useMutation({
    /* No `queueWhenOffline`: asking for a sync while offline is pointless —
       the queue would replay it minutes later against a worker that was going
       to sweep anyway. */
    mutationFn: () =>
      api<{ accountId: string; queued: true; estimatedSeconds: number }>(
        `/mail-accounts/${account.id}/sync`,
        { method: 'POST', body: {} },
      ),
    onSuccess: (result) => {
      haptic('success');
      setError(null);
      /* 202 with an estimate, and the estimate is the message. A spinner here
         would promise mail that is not on its way: the endpoint puts the
         mailbox on a queue and returns, and the reading happens on the
         worker's own tick.

         `estimatedSeconds: 0` is not "instantly" — `nextSweepInSeconds()`
         answers zero only when the scheduler is switched off on the server, so
         it is reported as "cannot say" rather than as "now". */
      onDone(
        result.estimatedSeconds > 0
          ? `সিঙ্কের অনুরোধ জমা হয়েছে। আনুমানিক ${bnSeconds(result.estimatedSeconds)} পর মেইল পড়া হবে — এখনই নয়।`
          : t(
              'mail.syncQueued',
              'সিঙ্কের অনুরোধ জমা হয়েছে। কখন পড়া হবে তা সার্ভার জানাতে পারেনি।',
            ),
      );
    },
    onError: (err) => {
      haptic('warn');
      setError(messageFor(err));
    },
  });

  const toggle = useMutation({
    mutationFn: (status: 'ACTIVE' | 'DISABLED') =>
      api<MailAccountView>(`/mail-accounts/${account.id}`, { method: 'PATCH', body: { status } }),
    onSuccess: (saved) => {
      haptic('select');
      setError(null);
      onDone(
        saved.status === 'ACTIVE'
          ? `${saved.email} আবার চালু হয়েছে।`
          : `${saved.email} সাময়িকভাবে বন্ধ করা হয়েছে। আগে আনা বার্তাগুলো থেকে যাবে।`,
      );
    },
    onError: (err) => {
      haptic('warn');
      setError(messageFor(err));
    },
  });

  const busy = sync.isPending || toggle.isPending;
  const broken = account.status === 'AUTH_FAILED';
  const next = nextSweepLine(account.status, account.lastSyncAt, now);

  return (
    <div className="border-rule rounded-xl border p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <p className="text-ink min-w-0 break-all text-sm font-medium">{account.email}</p>
        <StatusPill status={account.status} />
      </div>

      <dl className="text-ink-muted mt-1.5 flex flex-col gap-0.5 text-xs">
        {account.imapHost ? (
          <div className="flex min-w-0 flex-wrap gap-x-1.5">
            <dt className="shrink-0">{t('mail.server', 'সার্ভার')}</dt>
            <dd className="min-w-0 break-all font-mono">
              {account.imapHost}
              {account.imapPort ? `:${account.imapPort}` : ''}
            </dd>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-wrap gap-x-1.5">
          <dt className="shrink-0">{t('mail.fetched', 'আনা হয়েছে')}</dt>
          <dd>{bnNum(account.messageCount)}টি বার্তা</dd>
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-1.5">
          <dt className="shrink-0">{t('mail.sync', 'সিঙ্ক')}</dt>
          <dd>
            {lastSyncLine(account.lastSyncAt)}
            {next ? ` · ${next}` : ''}
          </dd>
        </div>
        {account.syncSince ? (
          <div className="flex min-w-0 flex-wrap gap-x-1.5">
            <dt className="shrink-0">{t('mail.since', 'কবে থেকে')}</dt>
            <dd>{bnDate(account.syncSince)} তারিখের পর থেকে</dd>
          </div>
        ) : null}
      </dl>

      {broken ? <AuthFailedNotice account={account} onFix={onRepair} className="mt-3" /> : null}

      {/* A failure that is *not* AUTH_FAILED leaves the mailbox running: the
          worker will try again on the next sweep, and saying so is the
          difference between a warning and an alarm. */}
      {!broken && account.lastError ? (
        <p className="bg-brass/10 text-brass mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-xs">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            শেষবার পড়া যায়নি: {account.lastError} সিঙ্ক বন্ধ হয়নি — পরের বার আবার চেষ্টা করা হবে।
          </span>
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-expense mt-2 text-xs">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || account.status !== 'ACTIVE'}
          title={
            account.status === 'ACTIVE'
              ? undefined
              : t('mail.pausedNoSync', 'বন্ধ থাকা মেইলবক্স সিঙ্ক করা যায় না')
          }
          onClick={() => sync.mutate()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          এখনই সিঙ্ক
        </Button>

        <Button variant="outline" size="sm" disabled={busy} onClick={onRepair}>
          <KeyRound className="h-4 w-4" aria-hidden />
          পাসওয়ার্ড দিন
        </Button>

        {/* Not offered for AUTH_FAILED: the API refuses `status: 'ACTIVE'`
            without a credential, on purpose, so a button that could only ever
            return an error has no business being on the screen. */}
        {broken ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => toggle.mutate(account.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}
          >
            <Power className="h-4 w-4" aria-hidden />
            {account.status === 'ACTIVE'
              ? t('mail.pause', 'সাময়িক বন্ধ')
              : t('mail.resume', 'আবার চালু')}
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="text-expense"
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          সরিয়ে ফেলুন
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Connecting
   --------------------------------------------------------------------------- */

interface ConnectForm {
  email: string;
  imapHost: string;
  imapPort: string;
  username: string;
  password: string;
  syncSince: string;
}

const EMPTY_FORM: ConnectForm = {
  email: '',
  imapHost: '',
  imapPort: DEFAULT_PORT,
  username: '',
  password: '',
  syncSince: '',
};

function ConnectSheet({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (account: MailAccountView) => void;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="মেইলবক্স যুক্ত করুন"
      description="পাসওয়ার্ড যাচাই করে তবেই সংরক্ষণ করা হয়"
      className="md:w-[34rem]"
    >
      {/* Keyed on `open`, so closing and reopening starts from a blank form —
          most importantly a blank password field. */}
      <ConnectFormBody key={String(open)} onConnected={onConnected} />
    </Sheet>
  );
}

function ConnectFormBody({ onConnected }: { onConnected: (account: MailAccountView) => void }) {
  const [form, setForm] = React.useState<ConnectForm>(EMPTY_FORM);
  const [error, setError] = React.useState<string | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  const set =
    (key: keyof ConnectForm) =>
    (e: { target: { value: string } }): void =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const domain = domainOf(form.email);
  const suggestedHost = HOST_GUESS[domain];
  const needsAppPassword = APP_PASSWORD_DOMAINS.includes(domain);

  /* Checked as they type, before the password field is even reached. The
     server refuses these too, with 422 and its own sentence; this only moves
     the bad news earlier, which is the whole point — nobody should go and find
     a password that cannot work. */
  const microsoft = isMicrosoftMailbox(form.email, form.imapHost);

  const connect = useMutation({
    /* No `queueWhenOffline`, and this is the one place where that is a security
       property rather than a preference: the offline queue writes the request
       body to IndexedDB, and this body has a password in it. */
    mutationFn: () =>
      api<MailAccountView>('/mail-accounts', {
        method: 'POST',
        body: {
          provider: 'IMAP',
          email: form.email.trim(),
          imapHost: form.imapHost.trim(),
          imapPort: Number(form.imapPort) || Number(DEFAULT_PORT),
          ...(form.username.trim() ? { username: form.username.trim() } : {}),
          password: form.password,
          ...(form.syncSince ? { syncSince: form.syncSince } : {}),
        },
      }),
    onSuccess: (account) => {
      haptic('success');
      /* Out of memory the moment it is no longer needed. It was never written
         anywhere else, and the API does not return it. */
      setForm(EMPTY_FORM);
      onConnected(account);
    },
    onError: (err) => {
      haptic('warn');
      if (isExplanation(err)) {
        setRefusal(messageFor(err));
        setError(null);
      } else {
        setRefusal(null);
        setError(messageFor(err));
      }
    },
  });

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    setRefusal(null);

    if (!form.email.trim()) return setError(t('mail.needEmail', 'ইমেইল ঠিকানা দিন'));
    if (!form.imapHost.trim()) return setError(t('mail.needServer', 'IMAP সার্ভারের ঠিকানা দিন'));
    if (!form.password) return setError(t('mail.needPassword', 'পাসওয়ার্ড দিন'));
    connect.mutate();
  };

  const blocked = microsoft || refusal !== null;

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <p className="text-ink-muted text-xs">
        যে ইমেইলে ব্যাংক বা কার্ডের স্টেটমেন্ট আসে সেটি দিন। পাসওয়ার্ডটি সার্ভারে এনক্রিপ্ট করে
        রাখা হয়, এই ব্রাউজারে কোথাও জমা থাকে না, আর কখনো ফেরত পাঠানো হয় না।
      </p>

      <Field label="ইমেইল ঠিকানা" htmlFor="mail-email">
        <Input
          id="mail-email"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={form.email}
          onChange={set('email')}
          placeholder="apnar.naam@gmail.com"
        />
      </Field>

      {/* Before the password field, deliberately. */}
      {microsoft ? <MicrosoftNotice /> : null}
      {refusal ? <MicrosoftNotice message={refusal} /> : null}

      <fieldset disabled={blocked || connect.isPending} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">{t('mail.serverDetails', 'সার্ভারের তথ্য')}</legend>

        <Field label="IMAP সার্ভার" htmlFor="mail-host">
          <Input
            id="mail-host"
            value={form.imapHost}
            onChange={set('imapHost')}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={suggestedHost ?? 'imap.example.com'}
            className="font-mono text-sm"
          />
          {suggestedHost && form.imapHost.trim() === '' ? (
            <button
              type="button"
              className="text-income self-start text-xs underline"
              onClick={() => setForm((f) => ({ ...f, imapHost: suggestedHost }))}
            >
              {suggestedHost} বসিয়ে দিন
            </button>
          ) : null}
        </Field>

        <Field label="পোর্ট" htmlFor="mail-port">
          <Input
            id="mail-port"
            type="number"
            inputMode="numeric"
            min={1}
            max={65535}
            value={form.imapPort}
            onChange={set('imapPort')}
          />
          <p className="text-ink-muted text-xs">
            প্রায় সব সার্ভারেই {bnNum(993)} — না জানলে বদলাবেন না।
          </p>
        </Field>

        <Field label="পাসওয়ার্ড" htmlFor="mail-password">
          <Input
            id="mail-password"
            type="password"
            /* Never pre-filled, never remembered. `new-password` keeps a browser
               from auto-filling the user's *own* account password into a field
               that goes to a third-party mail host. */
            autoComplete="new-password"
            spellCheck={false}
            value={form.password}
            onChange={set('password')}
          />
          {needsAppPassword ? (
            <p className="text-ink-muted text-xs">
              এই সেবাগুলোতে আপনার সাধারণ পাসওয়ার্ড কাজ করবে না। অ্যাকাউন্টের নিরাপত্তা সেটিংসে
              গিয়ে দুই ধাপে যাচাই চালু করে একটি{' '}
              <strong>{t('mail.appPassword', 'অ্যাপ পাসওয়ার্ড')}</strong> বানান, সেটি এখানে দিন।
            </p>
          ) : null}
        </Field>

        <details className="border-rule rounded-xl border p-3">
          <summary className="text-ink cursor-pointer text-sm font-medium">
            আরও সেটিং (ইচ্ছা হলে)
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="ইউজারনেম" htmlFor="mail-username">
              <Input
                id="mail-username"
                value={form.username}
                onChange={set('username')}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  form.email.trim() || t('mail.usesEmail', 'ইমেইল ঠিকানাটিই ব্যবহার হবে')
                }
              />
              <p className="text-ink-muted text-xs">
                খালি রাখলে ইমেইল ঠিকানাটিই ব্যবহার হবে। কিছু সার্ভার আলাদা নাম চায়।
              </p>
            </Field>

            <Field label="কবে থেকের মেইল আনা হবে" htmlFor="mail-since">
              <Input
                id="mail-since"
                type="date"
                value={form.syncSince}
                onChange={set('syncSince')}
              />
              <p className="text-ink-muted text-xs">
                খালি রাখলে গত {bnNum(30)} দিনের মেইল আনা হবে। এর আগের কোনো বার্তা কখনোই পড়া হবে না।
              </p>
            </Field>
          </div>
        </details>
      </fieldset>

      {error ? (
        <p role="alert" className="bg-expense/10 text-expense rounded-xl px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {/* Not a spinner with an indeterminate promise: the wait is a real TLS
          handshake and login against somebody else's server, and saying so is
          why a ten-second pause does not read as a hang. */}
      {connect.isPending ? (
        <p role="status" className="text-ink-muted text-sm">
          মেইল সার্ভারে সংযোগ করে পাসওয়ার্ড যাচাই করা হচ্ছে… এতে কয়েক সেকেন্ড লাগতে পারে।
        </p>
      ) : null}

      <Button type="submit" size="block" disabled={blocked || connect.isPending}>
        {connect.isPending
          ? t('mail.checking', 'যাচাই করা হচ্ছে…')
          : t('mail.checkAndAdd', 'যাচাই করে যুক্ত করুন')}
      </Button>
    </form>
  );
}

/**
 * Microsoft, explained rather than blamed.
 *
 * Brass and an `Info`, not red and a `TriangleAlert`: nothing the person typed
 * is wrong, and nothing they can type will fix it. Microsoft finished removing
 * password-based IMAP for Exchange Online in 2022–23 and for personal Outlook
 * accounts in 2024. There is no setting and no app-password equivalent.
 */
function MicrosoftNotice({ message }: { message?: string }) {
  return (
    <div className="bg-brass/10 text-brass flex items-start gap-2 rounded-xl px-3 py-2 text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {message ??
          'Microsoft (Outlook / Hotmail / Live / Microsoft 365) পাসওয়ার্ড দিয়ে IMAP সংযোগ বন্ধ করে দিয়েছে।'}{' '}
        <strong>{t('mail.notYourPassword', 'এটি আপনার পাসওয়ার্ডের সমস্যা নয়')}</strong> — নতুন
        পাসওয়ার্ড বানিয়েও কাজ হবে না, কারণ সুবিধাটিই আর নেই। অন্য কোনো ইমেইল ঠিকানা ব্যবহার করুন,
        অথবা ব্যাংকের স্টেটমেন্ট সেই ঠিকানায় পাঠাতে বলুন।
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Re-entering a password
   --------------------------------------------------------------------------- */

function PasswordSheet({
  account,
  onClose,
  onSaved,
}: {
  account: MailAccountView | null;
  onClose: () => void;
  onSaved: (account: MailAccountView) => void;
}) {
  return (
    <Sheet
      open={account !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="নতুন পাসওয়ার্ড"
      description={account?.email}
      className="md:w-[34rem]"
    >
      {account ? <PasswordFormBody key={account.id} account={account} onSaved={onSaved} /> : null}
    </Sheet>
  );
}

function PasswordFormBody({
  account,
  onSaved,
}: {
  account: MailAccountView;
  onSaved: (account: MailAccountView) => void;
}) {
  /* The host is pre-filled because it is not a secret and retyping it is a
     needless chance to get it wrong. The password is not, and cannot be: the
     API has never returned it and this file has never held it. */
  const [host, setHost] = React.useState(account.imapHost ?? '');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  const save = useMutation({
    // Never queued offline — the body carries a password. See `ConnectFormBody`.
    mutationFn: () =>
      api<MailAccountView>(`/mail-accounts/${account.id}`, {
        method: 'PATCH',
        body: {
          password,
          ...(host.trim() && host.trim() !== account.imapHost ? { imapHost: host.trim() } : {}),
        },
      }),
    onSuccess: (saved) => {
      haptic('success');
      setPassword('');
      onSaved(saved);
    },
    onError: (err) => {
      haptic('warn');
      if (isExplanation(err)) {
        setRefusal(messageFor(err));
        setError(null);
      } else {
        setRefusal(null);
        setError(messageFor(err));
      }
    },
  });

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    setRefusal(null);
    if (!password) return setError(t('mail.needPassword', 'পাসওয়ার্ড দিন'));
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <p className="text-ink-muted text-sm">
        নতুন পাসওয়ার্ডটি মেইল সার্ভারে যাচাই করে তবেই রাখা হয়।{' '}
        {account.status === 'AUTH_FAILED'
          ? t(
              'mail.resumeAfterCheck',
              'যাচাই হয়ে গেলে এই মেইলবক্সের সিঙ্ক আবার চালু হবে — এর আগে নয়।',
            )
          : t('mail.replacesPassword', 'আগের পাসওয়ার্ডটি বদলে যাবে।')}
      </p>

      {refusal ? <MicrosoftNotice message={refusal} /> : null}

      <fieldset disabled={save.isPending || refusal !== null} className="flex flex-col gap-4">
        <legend className="sr-only">{t('mail.newPassword', 'নতুন পাসওয়ার্ড')}</legend>

        <Field label="পাসওয়ার্ড" htmlFor="mail-new-password">
          <Input
            id="mail-new-password"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-ink-muted text-xs">
            Gmail, Yahoo বা iCloud হলে সাধারণ পাসওয়ার্ড নয় — অ্যাপ পাসওয়ার্ড দিন।
          </p>
        </Field>

        <Field label="IMAP সার্ভার" htmlFor="mail-new-host">
          <Input
            id="mail-new-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
          />
        </Field>
      </fieldset>

      {error ? (
        <p role="alert" className="bg-expense/10 text-expense rounded-xl px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {save.isPending ? (
        <p role="status" className="text-ink-muted text-sm">
          মেইল সার্ভারে যাচাই করা হচ্ছে… কয়েক সেকেন্ড লাগতে পারে।
        </p>
      ) : null}

      <Button type="submit" size="block" disabled={save.isPending || refusal !== null}>
        {save.isPending
          ? t('mail.checking', 'যাচাই করা হচ্ছে…')
          : t('mail.checkAndSave', 'যাচাই করে সংরক্ষণ করুন')}
      </Button>
    </form>
  );
}

/* ---------------------------------------------------------------------------
   Disconnecting
   --------------------------------------------------------------------------- */

/**
 * Disconnecting, with the consequence stated before the button.
 *
 * This is not "stop syncing". The API deletes every message that mailbox
 * brought in, in the same transaction, and destroys the stored credential —
 * `MailMessage` has no soft delete, and the alternative to deleting was leaving
 * somebody's private mail in the database forever with no way to remove it.
 * None of that is guessable from the word "disconnect", so the count is on the
 * screen before the tap and again in the receipt after it.
 */
function DisconnectSheet({
  account,
  onClose,
  onRemoved,
}: {
  account: MailAccountView | null;
  onClose: () => void;
  onRemoved: (email: string, messagesRemoved: number) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; deleted: true; messagesRemoved: number }>(`/mail-accounts/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: (result) => {
      haptic('warn');
      onRemoved(account?.email ?? '', result.messagesRemoved);
    },
    onError: (err) => setError(messageFor(err)),
  });

  return (
    <Sheet
      open={account !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          onClose();
        }
      }}
      title="মেইলবক্স সরিয়ে ফেলবেন?"
      description={account?.email}
    >
      {account ? (
        <div className="flex flex-col gap-4">
          <p className="text-ink text-sm">
            এই মেইলবক্স থেকে আনা{' '}
            <strong>
              {account.messageCount > 0
                ? `${bnNum(account.messageCount)}টি বার্তাই মুছে ফেলা হবে`
                : t('mail.removesMessages', 'সব বার্তা মুছে ফেলা হবে')}
            </strong>{' '}
            — এখান থেকে, চিরতরে। ফিরিয়ে আনার কোনো উপায় নেই।
          </p>
          <p className="text-ink-muted text-sm">
            আপনার আসল মেইলবক্সে কোনো মেইল মোছা হবে না — যা মোছা হবে তা কেবল এই অ্যাপে জমানো অনুলিপি।
            সংরক্ষিত পাসওয়ার্ডটিও মুছে যাবে, তাই আবার যুক্ত করতে চাইলে পাসওয়ার্ড আবার দিতে হবে।
          </p>
          <p className="text-ink-muted text-sm">
            শুধু কিছুদিনের জন্য থামাতে চাইলে সরিয়ে না ফেলে{' '}
            <strong>{t('mail.pause', 'সাময়িক বন্ধ')}</strong> করুন — তাতে বার্তাগুলো থেকে যাবে।
          </p>

          {error ? (
            <p role="alert" className="bg-expense/10 text-expense rounded-xl px-3 py-2 text-sm">
              {error}
            </p>
          ) : null}

          <Button
            variant="danger"
            size="block"
            disabled={remove.isPending}
            onClick={() => remove.mutate(account.id)}
          >
            {remove.isPending
              ? t('common.removing', 'সরানো হচ্ছে…')
              : account.messageCount > 0
                ? `${bnNum(account.messageCount)}টি বার্তাসহ সরিয়ে ফেলুন`
                : t('common.remove', 'সরিয়ে ফেলুন')}
          </Button>
          <Button variant="outline" size="block" onClick={onClose}>
            থাক
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}
