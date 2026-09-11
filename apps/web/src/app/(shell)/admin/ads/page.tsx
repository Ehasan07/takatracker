'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { SkeletonRows } from '@/components/skeleton';
import { ApiError } from '@/lib/api';
import {
  adminKeys,
  createAdCampaign,
  deleteAdCampaign,
  fetchAdCampaigns,
  fetchTenants,
  invalidateAdminData,
  placeAd,
  updateAdCampaign,
  withdrawAd,
  type AdCampaignBody,
} from '../queries';
import type { AdCampaignRow } from '../types';

/**
 * Sponsored footers.
 *
 * Two things are managed here and they are deliberately separate. A **campaign**
 * is what a sponsor wants printed — the wording, edited in one place however
 * many shops carry it. A **placement** is one campaign switched on for one
 * workspace, with an optional window.
 *
 * Where it shows up: the bottom of printed documents and PDFs — party ledgers,
 * loan statements, the financial statements, the party due report, and the
 * statement a shop shares with a customer. Never on screen, and never in a
 * spreadsheet export: a CSV or an XLSX is a file somebody sorts and pastes into
 * their own workbook, and advertising copy in a cell breaks their formulas.
 */
export default function AdsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<AdCampaignRow | 'new' | null>(null);
  const [placing, setPlacing] = React.useState<AdCampaignRow | null>(null);

  const campaigns = useQuery({
    queryKey: adminKeys.ads(),
    queryFn: fetchAdCampaigns,
    retry: false,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAdCampaign(id),
    onSuccess: () => invalidateAdminData(queryClient),
  });

  const toggle = useMutation({
    mutationFn: (row: AdCampaignRow) => updateAdCampaign(row.id, { isActive: !row.isActive }),
    onSuccess: () => invalidateAdminData(queryClient),
  });

  const withdraw = useMutation({
    mutationFn: (input: { id: string; workspaceId: string }) =>
      withdrawAd(input.id, input.workspaceId),
    onSuccess: () => invalidateAdminData(queryClient),
  });

  const rows = campaigns.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-ink text-xl font-semibold sm:text-2xl">বিজ্ঞাপন</h1>
          <p className="text-ink-muted text-sm">
            যে ওয়ার্কস্পেসকে দেবেন, তার প্রিন্ট করা কাগজ ও PDF-এর একেবারে নিচে দেখাবে। এক্সেলে কখনো
            নয়, স্ক্রিনেও নয়।
          </p>
        </div>
        <Button onClick={() => setEditing('new')} size="sm">
          <Plus className="h-4 w-4" aria-hidden />
          নতুন বিজ্ঞাপন
        </Button>
      </header>

      {campaigns.isPending ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={4} />
        </div>
      ) : campaigns.isError ? (
        <p className="rounded-card border-rule bg-surface text-ink border p-6 text-sm">
          {campaigns.error instanceof ApiError ? campaigns.error.message : 'তালিকা আনা যায়নি।'}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-ink-muted rounded-card border-rule bg-surface border p-6 text-center text-sm">
          এখনো কোনো বিজ্ঞাপন নেই।
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded-card border-rule bg-surface flex flex-col gap-3 border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-ink-muted text-xs">{row.name}</p>
                  <p className="text-ink font-semibold">{row.headline}</p>
                  {row.body ? <p className="text-ink-muted mt-1 text-sm">{row.body}</p> : null}
                  {row.contactLine ? (
                    <p className="text-ink-muted text-xs">{row.contactLine}</p>
                  ) : null}
                </div>
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-xs ${
                    row.isActive ? 'bg-greenbar text-ink' : 'text-ink-muted border-rule border'
                  }`}
                >
                  {row.isActive ? 'চালু' : 'বন্ধ'}
                </span>
              </div>

              <div>
                <p className="text-ink-muted mb-1 text-xs">
                  যেসব ওয়ার্কস্পেসে চলছে · {row.placements.length}
                </p>
                {row.placements.length === 0 ? (
                  <p className="text-ink-muted text-sm">কোথাও দেওয়া হয়নি।</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {row.placements.map((placement) => (
                      <li
                        key={placement.id}
                        className="border-rule text-ink flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm"
                      >
                        <Building2 className="text-ink-muted h-3.5 w-3.5" aria-hidden />
                        <span className="max-w-40 truncate">{placement.workspaceName}</span>
                        {placement.endsAt ? (
                          <span className="text-ink-muted text-xs">
                            {placement.endsAt.slice(0, 10)} পর্যন্ত
                          </span>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`${placement.workspaceName} থেকে সরান`}
                          onClick={() =>
                            withdraw.mutate({ id: row.id, workspaceId: placement.workspaceId })
                          }
                          className="press text-ink-muted hover:text-expense"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setPlacing(row)}>
                  <Building2 className="h-4 w-4" aria-hidden />
                  ওয়ার্কস্পেসে দিন
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  সম্পাদনা
                </Button>
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(row)}>
                  {row.isActive ? 'বন্ধ করুন' : 'চালু করুন'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    /* The cascade takes every placement with it, so the one
                       question worth asking is asked before it happens. */
                    if (window.confirm('বিজ্ঞাপনটি মুছে ফেললে সব ওয়ার্কস্পেস থেকেই সরে যাবে।'))
                      remove.mutate(row.id);
                  }}
                >
                  <Trash2 className="text-expense h-4 w-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CampaignSheet
        open={editing !== null}
        campaign={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
      />
      <PlacementSheet campaign={placing} onClose={() => setPlacing(null)} />
    </div>
  );
}

/** Create or edit the wording. One form for both — the fields are identical. */
function CampaignSheet({
  open,
  campaign,
  onClose,
}: {
  open: boolean;
  campaign: AdCampaignRow | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<AdCampaignBody>({ name: '', headline: '' });
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setForm({
      name: campaign?.name ?? '',
      headline: campaign?.headline ?? '',
      body: campaign?.body ?? '',
      contactLine: campaign?.contactLine ?? '',
      linkUrl: campaign?.linkUrl ?? '',
    });
  }, [open, campaign]);

  const save = useMutation({
    mutationFn: (body: AdCampaignBody) => {
      /* Empty string means "take this line off the page", and the API reads
         that as `null`. Sending `''` would print a blank line instead. */
      const clean: AdCampaignBody = {
        name: body.name.trim(),
        headline: body.headline.trim(),
        body: body.body?.trim() ? body.body.trim() : null,
        contactLine: body.contactLine?.trim() ? body.contactLine.trim() : null,
        linkUrl: body.linkUrl?.trim() ? body.linkUrl.trim() : null,
      };
      return campaign ? updateAdCampaign(campaign.id, clean) : createAdCampaign(clean);
    },
    onSuccess: () => {
      invalidateAdminData(queryClient);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  const ready = form.name.trim() !== '' && form.headline.trim() !== '';

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={campaign ? 'বিজ্ঞাপন সম্পাদনা' : 'নতুন বিজ্ঞাপন'}
      description="শিরোনাম ছাড়া বাকি সব ঐচ্ছিক। যা লিখবেন তাই ছাপা হবে।"
    >
      <div className="flex flex-col gap-3">
        <Field label="নাম (শুধু আপনার তালিকার জন্য)" htmlFor="ad-name">
          <Input
            id="ad-name"
            value={form.name}
            maxLength={120}
            onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
          />
        </Field>
        <Field label="শিরোনাম" htmlFor="ad-headline">
          <Input
            id="ad-headline"
            value={form.headline}
            maxLength={120}
            onChange={(event) => setForm((f) => ({ ...f, headline: event.target.value }))}
          />
        </Field>
        <Field label="বিবরণ" htmlFor="ad-body">
          <Textarea
            id="ad-body"
            rows={3}
            maxLength={280}
            value={form.body ?? ''}
            onChange={(event) => setForm((f) => ({ ...f, body: event.target.value }))}
          />
        </Field>
        <Field label="যোগাযোগ (ফোন, ঠিকানা বা ওয়েবসাইট)" htmlFor="ad-contact">
          <Input
            id="ad-contact"
            value={form.contactLine ?? ''}
            maxLength={160}
            onChange={(event) => setForm((f) => ({ ...f, contactLine: event.target.value }))}
          />
        </Field>
        <Field label="লিংক (ঐচ্ছিক, কাগজে ছাপা হয় না)" htmlFor="ad-link">
          <Input
            id="ad-link"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={form.linkUrl ?? ''}
            onChange={(event) => setForm((f) => ({ ...f, linkUrl: event.target.value }))}
          />
        </Field>

        {error ? <p className="text-expense text-sm">{error}</p> : null}

        <Button size="block" disabled={!ready || save.isPending} onClick={() => save.mutate(form)}>
          {save.isPending ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ'}
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * Put one campaign on one workspace.
 *
 * The picker searches the tenant list rather than offering every workspace:
 * choosing from a list of two thousand is not choosing, and the operator
 * already knows the shop's name.
 */
function PlacementSheet({
  campaign,
  onClose,
}: {
  campaign: AdCampaignRow | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [term, setTerm] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [chosen, setChosen] = React.useState<{ id: string; name: string } | null>(null);
  const [endsAt, setEndsAt] = React.useState('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  /* Debounced: every tenant search writes an audit row, and one row per letter
     typed is a log nobody reads. Same reason the users screen debounces. */
  React.useEffect(() => {
    const id = window.setTimeout(() => setQuery(term.trim()), 350);
    return () => window.clearTimeout(id);
  }, [term]);

  React.useEffect(() => {
    if (campaign) {
      setTerm('');
      setQuery('');
      setChosen(null);
      setEndsAt('');
      setNote('');
      setError(null);
    }
  }, [campaign]);

  const tenants = useQuery({
    queryKey: adminKeys.tenants({ q: query }),
    queryFn: () => fetchTenants({ q: query }),
    enabled: campaign !== null && query.length >= 2,
  });

  const place = useMutation({
    mutationFn: () =>
      placeAd(campaign?.id ?? '', {
        workspaceId: chosen?.id ?? '',
        /* End of that day, not its first instant: a placement "until the 30th"
           that stopped at midnight on the 30th would be one day short of what
           was sold. */
        endsAt: endsAt ? new Date(`${endsAt}T23:59:59.000Z`).toISOString() : null,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      invalidateAdminData(queryClient);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'দেওয়া যায়নি'),
  });

  return (
    <Sheet
      open={campaign !== null}
      onOpenChange={(next) => !next && onClose()}
      title="ওয়ার্কস্পেসে দিন"
      description={campaign?.headline ?? ''}
    >
      <div className="flex flex-col gap-3">
        <Field label="ওয়ার্কস্পেস খুঁজুন" htmlFor="ad-ws">
          <Input
            id="ad-ws"
            value={term}
            placeholder="নাম বা মালিকের ইমেইল"
            onChange={(event) => setTerm(event.target.value)}
          />
        </Field>

        {chosen ? (
          <p className="border-rule text-ink flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="truncate">{chosen.name}</span>
            <button type="button" className="press text-ink-muted" onClick={() => setChosen(null)}>
              বদলান
            </button>
          </p>
        ) : tenants.isFetching ? (
          <p className="text-ink-muted text-sm">খোঁজা হচ্ছে…</p>
        ) : (tenants.data?.items.length ?? 0) > 0 ? (
          <ul className="border-rule max-h-56 overflow-y-auto rounded-md border">
            {tenants.data?.items.map((tenant) => (
              <li key={tenant.id}>
                <button
                  type="button"
                  onClick={() => setChosen({ id: tenant.id, name: tenant.name })}
                  className="press text-ink hover:bg-greenbar min-h-11 w-full px-3 text-left text-sm"
                >
                  {tenant.name}
                </button>
              </li>
            ))}
          </ul>
        ) : query.length >= 2 ? (
          <p className="text-ink-muted text-sm">কিছু পাওয়া যায়নি।</p>
        ) : null}

        <Field label="কবে পর্যন্ত (ঐচ্ছিক)" htmlFor="ad-ends">
          <Input
            id="ad-ends"
            type="date"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
          />
        </Field>

        <Field label="কেন (ঐচ্ছিক)" htmlFor="ad-note">
          <Input
            id="ad-note"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>

        {error ? <p className="text-expense text-sm">{error}</p> : null}

        <Button size="block" disabled={!chosen || place.isPending} onClick={() => place.mutate()}>
          {place.isPending ? 'দেওয়া হচ্ছে…' : 'এই ওয়ার্কস্পেসে চালু করুন'}
        </Button>
      </div>
    </Sheet>
  );
}
