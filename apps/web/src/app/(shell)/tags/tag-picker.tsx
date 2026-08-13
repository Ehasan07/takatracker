'use client';

/**
 * Choose the tags on one transaction.
 *
 * Used by the quick-add sheet, which is also the transaction *edit* sheet, so
 * this is where almost every tag in the workspace will actually be applied —
 * and, because of the last point below, where most of them will be created.
 *
 * Four things it has to do, and the reason each one is not optional:
 *
 *  1. **Multi-select.** One category, many tags. A control that allowed one
 *     would turn tags into a second category by accident.
 *
 *  2. **Searchable, through the server.** `GET /tags?q=` transliterates, so
 *     `poribar` finds পরিবার. Filtering the fetched array here instead would
 *     look identical and silently lose that, because the two strings share no
 *     characters.
 *
 *  3. **Create inline.** A picker that makes somebody abandon a half-typed
 *     transaction, walk to /tags, create পারিবারিক and come back is a picker
 *     nobody uses twice — and an unused picker is an untagged ledger.
 *
 *  4. **Not a dialog.** It is rendered inside a sheet that is already a Radix
 *     dialog. A second layer on top of it on a phone is a trap: the back
 *     gesture closes the wrong thing.
 *
 * It lives in the tags folder rather than in `components/` because this folder
 * owns the tag domain — the DTO, the query keys and the invalidation rule are
 * all here, and a copy of them next to the sheet would be a second definition
 * of what a tag is.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Search, X } from 'lucide-react';
import * as React from 'react';
import { toBengaliDigits } from '@hishab/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { useDisplayName } from '@/lib/display-name';
import { TagDot } from './parts';
import { fetchTags, tagKeys } from './queries';
import { type TagDto } from './types';

const bn = (value: number | string): string => toBengaliDigits(String(value));

export function TagPicker({
  value,
  onChange,
  idPrefix = 'tags',
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Unique per host form, so two pickers on one page keep distinct label ids. */
  idPrefix?: string;
}) {
  const queryClient = useQueryClient();
  const { name: nameOf } = useDisplayName();
  const [typed, setTyped] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  /**
   * The current selection, readable and writable between renders.
   *
   * `onChange` is a plain setter, not a reducer, so every writer has to hand it
   * the whole list — and two tags created a moment apart resolve against
   * whatever `value` their closure captured, which for the second one is still
   * the list from before the first. The ref is therefore updated *eagerly*,
   * ahead of the render it will be confirmed by: reading `value` alone loses a
   * tag whenever two changes land in one tick, and the user watched both of
   * them appear.
   */
  const valueRef = React.useRef<readonly string[]>(value);
  valueRef.current = value;

  const commit = React.useCallback(
    (next: string[]): void => {
      valueRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  const select = React.useCallback(
    (id: string): void => {
      const current = valueRef.current;
      if (current.includes(id)) return;
      commit([...current, id]);
    },
    [commit],
  );

  /* One request when the typing stops, not one per keystroke — the same 300ms
     the khata's search box uses, so the two feel like one control. */
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  /* The whole list, always. It names the selected chips — a tag chosen last
     week is not in today's search results — and it is the list shown before
     anybody types. Cached across every opening of the sheet. */
  const all = useQuery({
    queryKey: tagKeys.list(''),
    queryFn: () => fetchTags(''),
    staleTime: 30_000,
  });

  const found = useQuery({
    queryKey: tagKeys.list(query),
    queryFn: () => fetchTags(query),
    enabled: query !== '',
    /* Keep the previous answer on screen while the next one is in flight: a
       list that empties itself between keystrokes reads as "no such tag". */
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });

  const everything = React.useMemo(() => all.data ?? [], [all.data]);
  const shown = query === '' ? everything : (found.data ?? []);

  const byId = React.useMemo(() => {
    const map = new Map<string, TagDto>();
    for (const tag of everything) map.set(tag.id, tag);
    for (const tag of found.data ?? []) map.set(tag.id, tag);
    return map;
  }, [everything, found.data]);

  const selected = value.map((id) => byId.get(id) ?? null);

  /* Exact, case-insensitively, against both names — the same pair the API
     refuses a duplicate on. Without this the create button offers to make a
     second পরিবার, and the API answers 400 to a button that should not have
     been there. */
  const typedName = typed.trim();
  const exists =
    typedName !== '' &&
    everything.some(
      (tag) =>
        tag.name.toLowerCase() === typedName.toLowerCase() ||
        (tag.nameBn ?? '').toLowerCase() === typedName.toLowerCase(),
    );
  const canCreate = typedName !== '' && !exists;

  /**
   * Create a tag and select it.
   *
   * Deliberately a bare `async` call rather than a `useMutation`. One mutation
   * hook tracks one mutation: start a second before the first has answered —
   * which is exactly what typing two tags in a row on a slow connection does —
   * and the observer switches to the newer one, so the first tag is created on
   * the server and then never selected in the sheet. Each call here owns its
   * own result and cannot be superseded by the next.
   */
  const [creating, setCreating] = React.useState(false);

  const createTag = async (name: string): Promise<void> => {
    setCreating(true);
    setError(null);
    try {
      const tag = await api<TagDto>('/tags', { method: 'POST', body: { name, nameBn: name } });
      haptic('success');
      /* Only clear the box if it still holds the name that was just created.
         The round trip takes long enough to type the next tag into it, and a
         search box that wipes itself a moment after you started typing is the
         kind of bug people blame on their own thumbs. */
      setTyped((current) => (current.trim() === name ? '' : current));
      setQuery((current) => (current === name ? '' : current));
      select(tag.id);
      /* The picker and the tag screen share this cache; the ledger and the
         report cannot have moved yet, because nothing carries the tag. */
      void queryClient.invalidateQueries({ queryKey: tagKeys.all });
    } catch (err) {
      haptic('warn');
      setError(err instanceof ApiError ? err.message : 'ট্যাগ তৈরি করা যায়নি');
    } finally {
      setCreating(false);
    }
  };

  const toggle = (id: string): void => {
    haptic('tap');
    setError(null);
    const current = valueRef.current;
    if (current.includes(id)) commit(current.filter((each) => each !== id));
    else select(id);
  };

  const searchId = `${idPrefix}-search`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={searchId} className="text-ink text-sm font-medium">
          ট্যাগ
        </label>
        <span className="text-ink-muted text-xs">যত খুশি, নাও দিতে পারেন</span>
      </div>

      {/* Said here as well as on /tags. This is where somebody first meets a
          tag, and "another category box" is exactly what it looks like until
          somebody says otherwise. */}
      <p className="text-ink-muted text-xs">
        ক্যাটাগরি বলে <span className="font-medium">কীসে</span> খরচ, ট্যাগ বলে{' '}
        <span className="font-medium">কার জন্য</span> — পারিবারিক, শ্বশুরবাড়ি, রমজান।
      </p>

      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="বেছে নেওয়া ট্যাগ">
          {selected.map((tag, i) => {
            const id = value[i]!;
            const name = tag ? nameOf(tag) : '…';
            return (
              <li key={id}>
                <span className="border-income bg-income/10 text-ink flex min-h-9 items-center gap-1 rounded-full border pl-2.5 pr-1 text-xs">
                  <TagDot color={tag?.color ?? null} className="h-2 w-2" />
                  <span className="max-w-32 truncate">{name}</span>
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={`${name} ট্যাগটি সরান`}
                    className="press hover:bg-income/20 flex h-7 w-7 items-center justify-center rounded-full"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="relative">
        <Search
          className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          id={searchId}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="খুঁজুন বা নতুন ট্যাগের নাম লিখুন"
          enterKeyHint="done"
          className="pl-9"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            /* This sits inside the transaction form. Enter here must not save
               the transaction — it means "the thing I just typed". */
            e.preventDefault();
            if (canCreate) void createTag(typedName);
            else if (shown[0]) toggle(shown[0].id);
          }}
        />
      </div>

      {canCreate ? (
        <button
          type="button"
          onClick={() => void createTag(typedName)}
          disabled={creating}
          className="press border-income text-income hover:bg-income/10 flex min-h-11 items-center gap-2 rounded-md border border-dashed px-3 text-left text-sm disabled:opacity-50"
        >
          <Plus className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">
            {creating ? 'তৈরি হচ্ছে…' : `"${typedName}" নামে নতুন ট্যাগ`}
          </span>
        </button>
      ) : null}

      {error ? (
        <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-xs">
          {error}
        </p>
      ) : null}

      {all.isError ? (
        <div
          role="alert"
          className="border-rule flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2"
        >
          <p className="text-ink-muted text-xs">ট্যাগের তালিকা আনা যায়নি।</p>
          <Button variant="outline" size="sm" onClick={() => void all.refetch()}>
            আবার
          </Button>
        </div>
      ) : all.isLoading ? (
        <p className="text-ink-muted text-xs">ট্যাগ আনা হচ্ছে…</p>
      ) : shown.length === 0 ? (
        <p className="text-ink-muted text-xs">
          {query === ''
            ? 'এখনও কোনো ট্যাগ নেই — উপরে নাম লিখে প্রথমটি বানান।'
            : 'এই নামে কোনো ট্যাগ নেই।'}
        </p>
      ) : (
        /* Scrolls inside its own box. Forty tags must not push the amount and
           the save button off a phone screen. */
        <ul className="app-scroll border-rule max-h-44 rounded-md border">
          {shown.map((tag) => {
            const on = value.includes(tag.id);
            return (
              <li key={tag.id} className="border-rule border-b last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggle(tag.id)}
                  aria-pressed={on}
                  className={cn(
                    'press hover:bg-greenbar flex min-h-11 w-full items-center gap-2 px-3 text-left',
                    on && 'bg-income/10',
                  )}
                >
                  <TagDot color={tag.color} />
                  <span className="text-ink min-w-0 flex-1 truncate text-sm">{nameOf(tag)}</span>
                  {tag.transactionCount > 0 ? (
                    <span className="text-ink-muted shrink-0 text-xs">
                      {bn(tag.transactionCount)}
                    </span>
                  ) : null}
                  {on ? <Check className="text-income h-4 w-4 shrink-0" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
