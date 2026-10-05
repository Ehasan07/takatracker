'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Send } from '@/components/icons';
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/field';
import { bnNum } from '../labels';
import { adminKeys, catalogueKeys, fetchPlans } from '../queries';

/**
 * Send a Telegram message to customers.
 *
 * ## Who can be reached, and why that is not a mailing list
 *
 * Only people who connected Telegram themselves and left it enabled. There is
 * no separate list to be on and none to opt out of — the binding *is* the
 * consent, given for the credit-card reminders and now carrying this too. Turn
 * the connection off in settings and both stop, immediately, without asking
 * anybody.
 *
 * ## Count first, send second
 *
 * The button says how many phones the message will reach before it reaches
 * them, and the send is a second, separate press. A broadcast tool without that
 * step is an accident waiting for a slip of the finger — this one goes to real
 * people's lock screens and cannot be recalled.
 */

interface Reach {
  connected: number;
  workspaces: number;
}

interface BroadcastResult {
  dryRun: boolean;
  eligible: number;
  sent: number;
  failed: number;
  withoutTelegram: number;
}

export default function AdminBroadcastPage() {
  const [message, setMessage] = React.useState('');
  const [planCode, setPlanCode] = React.useState('');
  const [counted, setCounted] = React.useState<BroadcastResult | null>(null);
  const [outcome, setOutcome] = React.useState<BroadcastResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reach = useQuery({
    queryKey: [...adminKeys.all, 'broadcast-reach'] as const,
    queryFn: () => api<Reach>('/admin/broadcast/reach'),
  });
  const plans = useQuery({ queryKey: catalogueKeys.plans(), queryFn: fetchPlans });

  const body = () => ({
    message,
    ...(planCode ? { planCode } : {}),
  });

  const count = useMutation({
    mutationFn: () =>
      api<BroadcastResult>('/admin/broadcast', {
        method: 'POST',
        body: { ...body(), dryRun: true },
      }),
    onSuccess: (res) => {
      setError(null);
      setOutcome(null);
      setCounted(res);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'গোনা যায়নি'),
  });

  const send = useMutation({
    mutationFn: () => api<BroadcastResult>('/admin/broadcast', { method: 'POST', body: body() }),
    onSuccess: (res) => {
      setError(null);
      setCounted(null);
      setOutcome(res);
      setMessage('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'পাঠানো যায়নি'),
  });

  /* Any edit invalidates the count. A number measured against a different
     message is worse than no number — it is the one somebody would trust. */
  const edit = (next: string): void => {
    setMessage(next);
    setCounted(null);
    setOutcome(null);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">বার্তা পাঠান</h1>
        <p className="text-ink-muted mt-1 text-sm">
          যাঁরা নিজে টেলিগ্রাম যুক্ত করেছেন এবং চালু রেখেছেন, কেবল তাঁদের কাছেই যাবে।
        </p>
      </header>

      <div className="rounded-card border-rule bg-brand-tint border p-4">
        <p className="text-ink text-sm">
          এখন পর্যন্ত{' '}
          <strong className="font-medium">{reach.data ? bnNum(reach.data.connected) : '…'}</strong>{' '}
          জনকে পাঠানো যাবে
          {reach.data ? ` (${bnNum(reach.data.workspaces)}টি ওয়ার্কস্পেস)` : ''}।
        </p>
        <p className="text-ink-muted mt-1 text-xs">
          বাকিরা টেলিগ্রাম যুক্ত করেননি। তাঁদের কাছে পাঠানোর কোনো উপায় নেই — এবং সেটাই ঠিক, কারণ
          সংযোগটাই তাঁদের সম্মতি।
        </p>
      </div>

      <Field label="কাদের" htmlFor="bc-plan">
        <Select id="bc-plan" value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
          <option value="">সবাই</option>
          {(plans.data ?? []).map((plan) => (
            <option key={plan.code} value={plan.code}>
              শুধু {plan.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="বার্তা" htmlFor="bc-message">
        <Textarea
          id="bc-message"
          rows={6}
          value={message}
          onChange={(e) => edit(e.target.value)}
          placeholder="যেমন: আগামীকাল রাত ২টা থেকে ৩টা পর্যন্ত অ্যাপ কিছুক্ষণ বন্ধ থাকবে।"
          maxLength={3000}
        />
        <p className="text-ink-muted mt-1 text-xs">
          {bnNum(message.length)} / {bnNum(3000)} অক্ষর। সাধারণ HTML চলে — <code>&lt;b&gt;</code>,{' '}
          <code>&lt;i&gt;</code>, <code>&lt;a href&gt;</code>।
        </p>
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!message.trim() || count.isPending}
          onClick={() => count.mutate()}
        >
          {count.isPending ? 'গোনা হচ্ছে…' : 'কতজনে যাবে দেখুন'}
        </Button>
        {counted && counted.eligible > 0 ? (
          <Button disabled={send.isPending} onClick={() => send.mutate()}>
            <Send className="h-4 w-4" aria-hidden />
            {send.isPending ? 'পাঠানো হচ্ছে…' : `${bnNum(counted.eligible)} জনকে পাঠান`}
          </Button>
        ) : null}
      </div>

      {counted ? (
        <div className="rounded-card border-brand/40 bg-surface border p-4">
          <p className="text-ink text-sm">
            <strong className="font-medium">{bnNum(counted.eligible)}</strong> জনের কাছে যাবে।{' '}
            {counted.withoutTelegram > 0
              ? `${bnNum(counted.withoutTelegram)}টি ওয়ার্কস্পেসে কেউ টেলিগ্রাম যুক্ত করেননি।`
              : ''}
          </p>
          {counted.eligible === 0 ? (
            <p className="text-ink-muted mt-1 text-sm">পাঠানোর মতো কেউ নেই।</p>
          ) : (
            <p className="text-ink-muted mt-1 text-xs">
              পাঠানোর পর ফেরানো যাবে না — বার্তাটি আরেকবার পড়ে নিন।
            </p>
          )}
        </div>
      ) : null}

      {outcome ? (
        <div className="rounded-card border-rule bg-brand-tint border p-4">
          <p className="text-ink text-sm">
            {bnNum(outcome.sent)} জনের কাছে গেছে
            {outcome.failed > 0 ? `, ${bnNum(outcome.failed)}টি যায়নি` : ''}।
          </p>
          {outcome.failed > 0 ? (
            <p className="text-ink-muted mt-1 text-xs">
              যেগুলো যায়নি সেখানে বট ব্লক করা বা চ্যাট মুছে ফেলা হয়েছে — ওই সংযোগগুলো নিজে থেকেই
              বন্ধ হয়ে গেছে।
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-expense text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
