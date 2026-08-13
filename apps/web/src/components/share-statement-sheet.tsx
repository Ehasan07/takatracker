'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { ApiError, api } from '@/lib/api';
import { fmtDate, fmtNumber, fmtStamp } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

/**
 * Make a link to a statement, and take it back.
 *
 * ## The token is shown once
 *
 * Only its hash is stored, so there is no reading it back later. That is the
 * point — a leaked backup must not contain working links — and it is why the
 * copy button appears the moment a link is made rather than in the list below.
 * Somebody who closes this without copying revokes and makes another, which
 * costs a tap.
 *
 * ## Why the list shows view counts
 *
 * There is no login on the far side; the link *is* the credential. So the only
 * way to notice a link sent to one person being opened forty times is to be
 * shown the number. It is not decoration.
 */

type Kind = 'PERSON' | 'LOAN' | 'SAVINGS' | 'INSURANCE';

interface ShareDto {
  id: string;
  from: string | null;
  to: string | null;
  label: string | null;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
}

const shareKeys = (kind: Kind, subjectId: string) => ['statement-shares', kind, subjectId] as const;

export function ShareStatementSheet({
  open,
  onOpenChange,
  kind,
  subjectId,
  subjectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: Kind;
  subjectId: string;
  /** Only for the sheet's own heading; the link carries its own copy. */
  subjectName: string;
}) {
  const queryClient = useQueryClient();
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [made, setMade] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) return;
    /* Nothing survives the sheet closing. A token left in state would be one
       stray re-render away from being shown to whoever opens it next. */
    setMade(null);
    setCopied(false);
    setError(null);
  }, [open]);

  const shares = useQuery({
    queryKey: shareKeys(kind, subjectId),
    queryFn: () =>
      api<ShareDto[]>(`/statement-shares?kind=${kind}&subjectId=${encodeURIComponent(subjectId)}`),
    enabled: open,
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ url: string }>('/statement-shares', {
        method: 'POST',
        body: {
          kind,
          subjectId,
          from: from || undefined,
          to: to || undefined,
          label: label.trim() || undefined,
        },
      }),
    onSuccess: (res) => {
      haptic('success');
      setMade(`${window.location.origin}${res.url}`);
      void queryClient.invalidateQueries({ queryKey: shareKeys(kind, subjectId) });
    },
    onError: (err) => {
      haptic('warn');
      setError(
        err instanceof ApiError ? err.message : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'),
      );
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/statement-shares/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('tap');
      void queryClient.invalidateQueries({ queryKey: shareKeys(kind, subjectId) });
    },
  });

  const copy = async (): Promise<void> => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made);
      setCopied(true);
      haptic('success');
    } catch {
      /* Clipboard refused — an insecure context, or permission denied. The
         box below is selectable, so there is still a way to take the link. */
      setCopied(false);
    }
  };

  const live = (share: ShareDto): boolean =>
    !share.revokedAt && new Date(share.expiresAt).getTime() > Date.now();

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('share.title', 'বিবরণী শেয়ার করুন')}
      description={subjectName}
    >
      <div className="flex flex-col gap-4">
        <p className="text-ink-muted text-sm">
          {t(
            'share.blurb',
            'একটি লিংক তৈরি হবে। যাকে পাঠাবেন তিনি অ্যাকাউন্ট ছাড়াই বিবরণীটি দেখতে ও প্রিন্ট করতে পারবেন — বদলাতে পারবেন না।',
          )}
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('share.from', 'শুরুর তারিখ')} htmlFor="share-from">
            <Input
              id="share-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label={t('share.to', 'শেষ তারিখ')} htmlFor="share-to">
            <Input id="share-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <p className="text-ink-muted -mt-2 text-xs">
          {t('share.wholeLife', 'দুটোই খালি রাখলে শুরু থেকে আজ পর্যন্ত পুরোটা যাবে।')}
        </p>

        <Field label={t('share.label', 'নিজের জন্য নোট (ঐচ্ছিক)')} htmlFor="share-label">
          <Input
            id="share-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={120}
            placeholder={t('share.labelHint', 'যেমন: ব্র্যাক ব্যাংকের জন্য')}
          />
        </Field>

        <Button
          type="button"
          size="block"
          disabled={create.isPending}
          onClick={() => {
            setError(null);
            create.mutate();
          }}
        >
          <Link2 className="h-4 w-4" aria-hidden />
          {create.isPending
            ? t('common.saving', 'সংরক্ষণ হচ্ছে…')
            : t('share.create', 'লিংক তৈরি করুন')}
        </Button>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        {made ? (
          <div className="rounded-card border-brand/40 bg-brand-tint border p-3">
            <p className="text-ink text-sm font-medium">
              {t('share.ready', 'লিংক তৈরি — এখনই কপি করে নিন')}
            </p>
            {/* Said plainly, because it is true and surprising. */}
            <p className="text-ink-muted mt-1 text-xs">
              {t(
                'share.onceOnly',
                'এই লিংকটি আর দ্বিতীয়বার দেখানো যাবে না। হারালে নতুন করে বানাতে হবে।',
              )}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={made}
                onFocus={(e) => e.currentTarget.select()}
                className="border-rule bg-surface text-ink min-h-11 w-full rounded-md border px-3 text-xs"
                aria-label={t('share.link', 'শেয়ার লিংক')}
              />
              <Button type="button" variant="outline" onClick={() => void copy()}>
                {copied ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                {copied ? t('share.copied', 'কপি হয়েছে') : t('share.copy', 'কপি')}
              </Button>
            </div>
          </div>
        ) : null}

        {shares.data && shares.data.length > 0 ? (
          <div>
            <h3 className="text-ink-muted text-sm font-medium">
              {t('share.existing', 'আগের লিংকগুলো')}
            </h3>
            <ul className="divide-rule border-rule mt-2 divide-y rounded-md border">
              {shares.data.map((share) => (
                <li key={share.id} className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="text-ink truncate text-sm">
                      {share.label ||
                        (share.from || share.to
                          ? `${fmtDate(share.from)} — ${fmtDate(share.to)}`
                          : t('share.wholeLifeShort', 'পুরোটা'))}
                    </p>
                    <p className="text-ink-muted text-xs">
                      {live(share)
                        ? t('share.until', 'মেয়াদ {date} পর্যন্ত').replace(
                            '{date}',
                            fmtStamp(share.expiresAt),
                          )
                        : share.revokedAt
                          ? t('share.revoked', 'বাতিল করা হয়েছে')
                          : t('share.expired', 'মেয়াদ শেষ')}
                      {' · '}
                      {t('share.views', '{n} বার খোলা হয়েছে').replace(
                        '{n}',
                        fmtNumber(share.viewCount),
                      )}
                    </p>
                  </div>
                  {live(share) ? (
                    <button
                      type="button"
                      onClick={() => revoke.mutate(share.id)}
                      disabled={revoke.isPending}
                      aria-label={t('share.revokeOne', 'এই লিংকটি বাতিল করুন')}
                      className="press touch-target text-expense hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
