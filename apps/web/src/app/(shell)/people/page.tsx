'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Merge, Pencil, Plus, Search, Trash2, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { ShareStatementSheet } from '@/components/share-statement-sheet';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError } from '@/lib/api';
import { t } from '@/lib/t';
import { haptic } from '@/lib/haptics';
import { fetchPeople, invalidatePersonData, peopleKeys } from './queries';
import {
  bn,
  bnDate,
  CARRIED_OVER_LABEL,
  initialsOf,
  positionLabel,
  RELATION_SUGGESTIONS,
  safePhotoUri,
  type DeletePersonResult,
  type MergePeopleResult,
  type PersonDto,
} from './types';

/**
 * The contacts screen.
 *
 * A `Person` used to exist only as a side effect of recording a loan, and
 * nothing in the product could edit one afterwards — a phone typed wrong was
 * permanent, and typing "করিম" twice created two people whose party ledgers each
 * showed half the debt with no sign the other half existed.
 */
export default function PeoplePage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [editing, setEditing] = React.useState<PersonDto | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [merging, setMerging] = React.useState<PersonDto | null>(null);
  const [deleting, setDeleting] = React.useState<PersonDto | null>(null);
  const [sharing, setSharing] = React.useState<PersonDto | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const people = useQuery({
    queryKey: peopleKeys.list(debounced),
    queryFn: () => fetchPeople(debounced),
  });

  const rows = people.data ?? [];
  const main = rows.filter((p) => p.bucket !== 'suggestion');
  const suggestions = rows.filter((p) => p.bucket === 'suggestion');

  const done = (message: string): void => {
    haptic('success');
    invalidatePersonData(queryClient);
    setToast(message);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">মানুষজন</h1>
          <p className="text-ink-muted text-xs">
            যাদের সাথে ধার-দেনা বা লেনদেন আছে। নাম, ফোন ও সম্পর্ক এখান থেকে ঠিক করুন।
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          নতুন
        </Button>
      </header>

      <div className="relative">
        <Search
          className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="নাম বা ফোন — করিম, karim, korim"
          aria-label="মানুষ খুঁজুন"
          className="pl-9"
        />
      </div>

      {people.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={3} />
        </div>
      ) : people.isError ? (
        <div className="rounded-card border-rule border border-dashed p-6 text-center">
          <p className="text-ink text-sm">{t('people.listFailed', 'তালিকা আনা যায়নি।')}</p>
          <Button className="mt-3" variant="outline" onClick={() => void people.refetch()}>
            আবার চেষ্টা করুন
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink text-sm">
            {debounced
              ? t('people.noneFound', 'কাউকে পাওয়া যায়নি।')
              : t('people.noneYet', 'এখনও কেউ যোগ করা হয়নি।')}
          </p>
          <p className="text-ink-muted mt-1 text-xs">
            ধার দিলে বা নিলে যাঁর নাম লিখবেন, তিনি নিজে থেকেই এখানে চলে আসবেন।
          </p>
        </div>
      ) : (
        <ul aria-label="মানুষজন" className="flex flex-col gap-2">
          {main.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              onEdit={() => setEditing(person)}
              onMerge={() => setMerging(person)}
              onShare={() => setSharing(person)}
            />
          ))}
        </ul>
      )}

      {suggestions.length > 0 ? (
        <section className="flex flex-col gap-2">
          {/* The matcher is guessing here, so the rows are separated rather than
              mixed in — a guess presented as a result is worse than no result. */}
          <h2 className="text-ink-muted px-1 text-xs font-medium">
            {t('people.maybe', 'হয়তো এঁদের খুঁজছেন')}
          </h2>
          <ul aria-label="হয়তো এঁদের খুঁজছেন" className="flex flex-col gap-2">
            {suggestions.map((person) => (
              <PersonCard
                key={person.id}
                person={person}
                onEdit={() => setEditing(person)}
                onMerge={() => setMerging(person)}
                onShare={() => setSharing(person)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <PersonSheet
        key={editing?.id ?? 'new'}
        open={adding || editing !== null}
        person={editing}
        onOpenChange={(open) => {
          if (!open) {
            setAdding(false);
            setEditing(null);
          }
        }}
        onSaved={(message) => {
          setAdding(false);
          setEditing(null);
          done(message);
        }}
        /* One sheet at a time: the editor closes as the question opens, the way
           the savings and insurance screens already do it. */
        onDelete={(person) => {
          setEditing(null);
          setDeleting(person);
        }}
      />
      {/* Mounted with the person it is for, so closing it forgets the token
          along with everything else. */}
      {sharing ? (
        <ShareStatementSheet
          open
          onOpenChange={(next) => {
            if (!next) setSharing(null);
          }}
          kind="PERSON"
          subjectId={sharing.id}
          subjectName={sharing.name}
        />
      ) : null}

      <MergeSheet
        person={merging}
        candidates={rows}
        onOpenChange={(open) => !open && setMerging(null)}
        onMerged={(message) => {
          setMerging(null);
          done(message);
        }}
      />

      <DeleteSheet
        person={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={(message) => {
          setDeleting(null);
          done(message);
        }}
      />

      {toast ? (
        <div
          role="status"
          className="border-rule bg-surface fixed inset-x-4 bottom-24 z-40 mx-auto max-w-md rounded-md border p-3 shadow-lg md:bottom-6"
        >
          <p className="text-ink text-sm">{toast}</p>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="press text-ink-muted mt-1 text-xs underline"
          >
            বন্ধ করুন
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PersonCard({
  person,
  onEdit,
  onMerge,
  onShare,
}: {
  person: PersonDto;
  onEdit: () => void;
  onMerge: () => void;
  onShare: () => void;
}) {
  const photo = safePhotoUri(person.photoUri);
  const position = positionLabel(person);

  return (
    <li className="rounded-card border-rule bg-surface border p-3">
      {/* The card itself opens the person, the way an account row does. The
          two labelled buttons that used to say সম্পাদনা and সরান are gone from
          the footer: the first was a second way of doing what tapping the card
          now does, and the second put the irreversible action beside it on a
          list where the only thing separating them is a few pixels of thumb.
          Both live inside now, the destructive one last. */}
      <button
        type="button"
        aria-label={`${person.name} — ${t('common.edit', 'সম্পাদনা')}`}
        onClick={onEdit}
        className="press flex w-full items-start gap-3 text-left"
      >
        <span
          aria-hidden
          className="bg-greenbar text-income flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold"
        >
          {photo ? (
            /* Plain `<img>`, not `next/image`: the source is a same-origin
               path this app served (see `safePhotoUri`), so there is nothing
               for the optimiser to fetch, resize or cache. */
            <img src={photo} alt="" className="h-full w-full object-cover" />
          ) : (
            initialsOf(person.name)
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="text-ink block truncate text-sm font-medium">
            {person.name}
            {/* Two suppliers can share a name and a shop phone; only this tells
                them apart, so it sits beside the name rather than on a detail
                screen nobody opens while reading a delivery note. */}
            <span className="text-ink-muted money ml-1.5 text-xs">{person.code}</span>
          </span>
          <span className="text-ink-muted block truncate text-xs">
            {[person.relation, person.phone ? bn(person.phone) : null]
              .filter(Boolean)
              .join(' · ') || t('people.noDetails', 'কোনো তথ্য নেই')}
          </span>
          {person.loanCount > 0 ? (
            <span className="text-ink-muted mt-0.5 block text-xs">
              {bn(person.loanCount)}টি ঋণ · সর্বশেষ {bnDate(person.lastActivityDate)}
            </span>
          ) : null}
        </span>

        <span className="shrink-0 text-right">
          {position ? (
            <>
              <Money minor={Math.abs(person.netMinor)} className="block text-sm" decimals={false} />
              <span className="text-ink-muted block text-[11px]">{position}</span>
            </>
          ) : null}
        </span>
        <Pencil className="text-ink-muted mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      </button>

      {person.duplicateOfIds.length > 0 ? (
        <p className="text-ink-muted bg-greenbar mt-2 flex items-start gap-1.5 rounded-md p-2 text-xs">
          <TriangleAlert className="text-expense mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            একই রকম আরও {bn(person.duplicateOfIds.length)}টি নাম আছে — একই মানুষ হলে মিলিয়ে দিন,
            নইলে তাঁর হিসাব দুই ভাগে থেকে যাবে।
          </span>
        </p>
      ) : null}

      <div className="border-rule mt-2 flex flex-wrap items-center gap-1 border-t pt-2">
        {person.loanCount > 0 ? (
          <Link
            href={`/loans/people/${person.id}`}
            className="press text-income min-h-11 rounded-md px-2 text-xs underline"
          >
            হিসাবের খাতা
          </Link>
        ) : null}
        {person.loanCount > 0 ? (
          /* Next to the ledger it shares, and only when there is one. A share
             button on somebody with no loans offers to send an empty page. */
          <button
            type="button"
            onClick={onShare}
            className="press text-ink hover:bg-greenbar flex min-h-11 items-center gap-1 rounded-md px-2 text-xs"
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            {t('share.short', 'শেয়ার')}
          </button>
        ) : null}
        {/* Merge stays on the card and stays labelled, for the reason written
            on the tag screen: a feature reachable only through an icon inside
            something else is a feature nobody finds, and two spellings of one
            person is the commonest mess on this screen. */}
        <button
          type="button"
          onClick={onMerge}
          className="press text-ink hover:bg-greenbar ml-auto flex min-h-11 items-center gap-1 rounded-md px-2 text-xs"
        >
          <Merge className="h-3.5 w-3.5" aria-hidden />
          মিলিয়ে দিন
        </button>
      </div>
    </li>
  );
}

function PersonSheet({
  open,
  person,
  onOpenChange,
  onSaved,
  onDelete,
}: {
  open: boolean;
  person: PersonDto | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (message: string) => void;
  /** Asks the page for `DeleteSheet`; this form never deletes anybody itself. */
  onDelete: (person: PersonDto) => void;
}) {
  const [form, setForm] = React.useState({
    name: person?.name ?? '',
    phone: person?.phone ?? '',
    relation: person?.relation ?? '',
    note: person?.note ?? '',
  });
  const [error, setError] = React.useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        relation: form.relation.trim() || null,
        note: form.note.trim() || null,
      };
      return person
        ? api<PersonDto>(`/people/${person.id}`, { method: 'PATCH', body })
        : api<PersonDto>('/people', { method: 'POST', body });
    },
    onSuccess: () =>
      onSaved(
        person ? t('people.updated', 'তথ্য বদলানো হয়েছে।') : t('people.added', 'যোগ করা হয়েছে।'),
      ),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={person ? t('people.edit', 'তথ্য বদলান') : t('people.new', 'নতুন মানুষ')}
      description={
        person
          ? undefined
          : t('people.autoAdded', 'ধার দেওয়া-নেওয়ার সময় নাম লিখলেও এখানে চলে আসবে।')
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <Field label="নাম" htmlFor="pp-name">
          <Input id="pp-name" value={form.name} onChange={set('name')} required />
        </Field>

        <Field label="ফোন" htmlFor="pp-phone">
          <Input
            id="pp-phone"
            value={form.phone}
            onChange={set('phone')}
            inputMode="tel"
            placeholder="01711223344"
          />
          <p className="text-ink-muted mt-1 text-xs">
            +৮৮ থাকুক বা না থাকুক, একই নম্বর হিসেবেই ধরা হবে।
          </p>
        </Field>

        <Field label="সম্পর্ক" htmlFor="pp-relation">
          <Input
            id="pp-relation"
            value={form.relation}
            onChange={set('relation')}
            list="pp-relations"
            placeholder="যেমন: মামা, বন্ধু, দোকানদার"
          />
          <datalist id="pp-relations">
            {RELATION_SUGGESTIONS.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </Field>

        <Field label="নোট" htmlFor="pp-note">
          <Input id="pp-note" value={form.note} onChange={set('note')} />
        </Field>

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="block" disabled={save.isPending}>
          সংরক্ষণ করুন
        </Button>

        {/* Last, below a rule, and only on somebody who already exists.
         *
         * The card used to carry this as a labelled button beside সম্পাদনা,
         * which is one thumb-width between "let me fix their phone number" and
         * "take them off the list". Down here the name is on screen, and the
         * sheet that follows still names the loan count that would refuse. */}
        {person ? (
          <div className="border-rule flex flex-col gap-2 border-t pt-4">
            <p className="text-ink-muted text-xs">
              {t(
                'people.deleteHint',
                'তালিকা থেকে সরালেও তাঁর কোনো লেনদেন মুছবে না। চলমান ঋণ থাকলে সরানোই যাবে না।',
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="block"
              className="text-expense"
              onClick={() => onDelete(person)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t('people.delete', 'তালিকা থেকে সরান')}
            </Button>
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}

function MergeSheet({
  person,
  candidates,
  onOpenChange,
  onMerged,
}: {
  person: PersonDto | null;
  candidates: PersonDto[];
  onOpenChange: (open: boolean) => void;
  onMerged: (message: string) => void;
}) {
  const [intoId, setIntoId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setIntoId('');
    setError(null);
  }, [person?.id]);

  const others = candidates.filter((c) => c.id !== person?.id);
  const into = others.find((c) => c.id === intoId) ?? null;

  const merge = useMutation({
    mutationFn: () =>
      api<MergePeopleResult>(`/people/${person!.id}/merge`, {
        method: 'POST',
        body: { intoPersonId: intoId },
      }),
    onSuccess: (result) => {
      const carried = result.carriedOver.map((f) => CARRIED_OVER_LABEL[f]).join(', ');
      const lostName =
        result.previousName && !result.previousName.kept
          ? ` পুরোনো নাম "${result.previousName.value}" আর খুঁজে পাওয়া যাবে না।`
          : '';
      onMerged(`${result.message}${carried ? ` (${carried} নেওয়া হয়েছে)` : ''}${lostName}`);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : t('people.mergeFailed', 'মেলানো যায়নি')),
  });

  return (
    <Sheet
      open={person !== null}
      onOpenChange={onOpenChange}
      title="দুজনকে মিলিয়ে দিন"
      description="একই মানুষ দুবার লেখা হয়ে থাকলে তাঁর সব হিসাব এক জায়গায় আনুন।"
    >
      {person ? (
        <div className="flex flex-col gap-4">
          <p className="text-ink-muted text-sm">
            <span className="text-ink font-medium line-through">{person.name}</span> মুছে যাবে, আর
            তাঁর সব ঋণ, কিস্তি ও লেনদেন যাঁকে বাছবেন তাঁর নামে চলে যাবে।
          </p>

          <Field label="কার সাথে মিলবে" htmlFor="pp-merge-into">
            <Select
              id="pp-merge-into"
              value={intoId}
              onChange={(e) => setIntoId(e.target.value)}
              required
            >
              <option value="">{t('common.choose2', 'বেছে নিন…')}</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.phone ? ` — ${c.phone}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          <ul className="text-ink-muted list-disc space-y-1 pl-5 text-xs">
            <li>{bn(person.loanCount)}টি ঋণ এবং তার কিস্তিগুলো সরে যাবে।</li>
            <li>{bn(person.transactionCount)}টি লেনদেনের নাম বদলে যাবে।</li>
            <li>
              {t('people.mergeFill', 'ফোন, সম্পর্ক বা নোটের ঘর যেখানে খালি, সেখানে পুরোনোটা বসবে।')}
            </li>
            <li>{t('people.mergeSafe', 'কোনো ঋণ বা লেনদেন মুছে ফেলা হবে না।')}</li>
          </ul>

          {error ? (
            <p role="alert" className="text-expense text-sm">
              {error}
            </p>
          ) : null}
          <Button
            size="block"
            disabled={!into || merge.isPending}
            onClick={() => {
              setError(null);
              merge.mutate();
            }}
          >
            {into ? `${into.name}-এর সাথে মিলিয়ে দিন` : t('people.pickFirst', 'আগে একজনকে বাছুন')}
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}

function DeleteSheet({
  person,
  onOpenChange,
  onDeleted,
}: {
  person: PersonDto | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: (message: string) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => setError(null), [person?.id]);

  const remove = useMutation({
    mutationFn: () => api<DeletePersonResult>(`/people/${person!.id}`, { method: 'DELETE' }),
    onSuccess: (result) => onDeleted(result.message),
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : t('people.removeFailed', 'সরানো যায়নি')),
  });

  return (
    <Sheet open={person !== null} onOpenChange={onOpenChange} title="তালিকা থেকে সরাবেন?">
      {person ? (
        <div className="flex flex-col gap-4">
          <p className="text-ink text-sm">
            <span className="font-medium">{person.name}</span> আপনার তালিকা থেকে সরে যাবে।
          </p>
          {/* The reassurance somebody wants at exactly this moment — and the API
              refuses outright while a loan still points at them. */}
          <p className="text-ink-muted text-xs">
            তাঁর {bn(person.transactionCount)}টি লেনদেনের কোনোটিই মুছে ফেলা হবে না। চলমান ঋণ থাকলে
            সরানোই যাবে না — আগে ঋণটি শেষ বা বাতিল করতে হবে।
          </p>

          {error ? (
            <p role="alert" className="text-expense text-sm">
              {error}
            </p>
          ) : null}
          <Button
            size="block"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => {
              setError(null);
              remove.mutate();
            }}
          >
            সরিয়ে ফেলুন
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}
