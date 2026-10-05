'use client';

/**
 * Find a খাত by typing, instead of scrolling a wheel through forty of them.
 *
 * ## Why this could not be a filter over the fetched array
 *
 * `category-picker.tsx` argued against a search box, and the argument was
 * specifically against a *client-side* one: filtering the array already in
 * memory would look identical to this and silently lose Banglish, because
 * `rickshaw` and রিকশা share no characters. That objection is answered by going
 * through `GET /categories?q=`, which transliterates every token, ranks the
 * workspace's own `searchAliases` a band below the real names, and pulls a
 * matched child's parent back in so nothing is orphaned. Nothing in this file
 * decides what matches; it renders what the server ranked.
 *
 * ## Why the two selects stayed
 *
 * They are the better control for browsing — the whole tree, in the OS's own
 * wheel on a phone, no request and no debounce. Search is for people who
 * already know the name; the wheel is for people who do not. Replacing the
 * wheel with a combobox would have made the second group's job harder to make
 * the first group's job faster, and the second group is everybody on their first
 * week.
 *
 * ## Why unmatched parents are dropped
 *
 * The API flags them `matched: false` — they are in the response so a tree
 * renderer has something to hang a child under. This is a flat list and each row
 * prints its own parent as a prefix, so a parent row that matched nothing is a
 * line that answers a question nobody asked. Ranking order is preserved
 * otherwise: the family whose best member scored highest is first, which is what
 * "the one I searched for comes to the top" means.
 */

import { useQuery } from '@tanstack/react-query';
import { Search, X } from '@/components/icons';
import * as React from 'react';
import { api, type CategoryDto } from '@/lib/api';
import { t } from '@/lib/t';
import { useDisplayName } from '@/lib/display-name';
import { haptic } from '@/lib/haptics';

type Kind = 'INCOME' | 'EXPENSE';

/** `?q=` adds two fields the plain list does not carry. */
interface CategoryHit extends CategoryDto {
  parentName?: string | null;
  /** Absent on an unfiltered list; `false` marks a parent pulled in for context. */
  matched?: boolean;
}

/** Long enough to be a filter. One character matches nearly everything, and the
 *  API says so too — it hands back the natural list rather than a ranked pretence. */
const MIN_QUERY = 2;

export function CategorySearch({
  kind,
  onPick,
  idPrefix,
}: {
  kind: Kind;
  /** The id to save: a sub-category when one was picked, else the parent. */
  onPick: (categoryId: string) => void;
  idPrefix: string;
}) {
  const { name: nameOf } = useDisplayName();
  const [typed, setTyped] = React.useState('');
  const [query, setQuery] = React.useState('');

  /* One request when the typing stops, not one per keystroke — the same 300ms
     the tag picker and the khata's search box use, so all three feel like one
     control. */
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const active = query.length >= MIN_QUERY;

  const found = useQuery({
    queryKey: ['categories', 'search', kind, query],
    queryFn: () => api<CategoryHit[]>(`/categories?kind=${kind}&q=${encodeURIComponent(query)}`),
    enabled: active,
    /* Keep the previous answer while the next is in flight: a list that empties
       itself between keystrokes reads as "no such খাত". */
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });

  /* Context-only parents dropped; every remaining row prints its own parent. */
  const hits = (found.data ?? []).filter((row) => row.matched !== false);

  const clear = (): void => {
    setTyped('');
    setQuery('');
  };

  const pick = (row: CategoryHit): void => {
    haptic('tap');
    onPick(row.id);
    clear();
  };

  const searchId = `${idPrefix}-category-search`;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Search
          className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <input
          id={searchId}
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={t('entry.searchCategoryHint', 'খাত খুঁজুন — রিকশা, khabar, বিদ্যুৎ')}
          aria-label={t('entry.searchCategory', 'খাত খুঁজুন')}
          enterKeyHint="search"
          className="border-rule bg-surface text-ink placeholder:text-ink-muted focus:border-brand focus:ring-brand/30 min-h-11 w-full rounded-md border pl-9 pr-9 text-sm focus:outline-none focus:ring-2"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              clear();
              return;
            }
            if (e.key !== 'Enter') return;
            /* This sits inside the transaction form. Enter here means "the top
               result", never "save the transaction". */
            e.preventDefault();
            const first = hits[0];
            if (first) pick(first);
          }}
        />
        {typed !== '' ? (
          <button
            type="button"
            onClick={clear}
            aria-label={t('common.clearSearch', 'খোঁজা বাদ দিন')}
            className="press text-ink-muted hover:text-ink absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* Nothing below the box until there is something to say. An empty result
          area on every entry would cost a row of a 320px sheet permanently. */}
      {!active ? null : found.isError ? (
        <p className="text-ink-muted text-xs">
          {t('entry.searchFailed', 'খোঁজা যায়নি — নিচের তালিকা থেকে বেছে নিন।')}
        </p>
      ) : hits.length === 0 ? (
        <p className="text-ink-muted text-xs">
          {found.isFetching
            ? t('common.searching', 'খোঁজা হচ্ছে…')
            : t('entry.noSuchCategory', 'এই নামে কোনো খাত নেই — নিচের তালিকা দেখুন।')}
        </p>
      ) : (
        /* Scrolls inside its own box. Twenty matches must not push the amount
           and the save button off a phone screen. Named, because the sheet also
           carries the accelerator strip — chips with the same খাত names on them
           — and "the যাতায়াত button" is otherwise two different controls. */
        <ul
          className="app-scroll border-rule max-h-44 rounded-md border"
          aria-label={t('common.searchResults', 'খোঁজার ফলাফল')}
        >
          {hits.map((row) => (
            <li key={row.id} className="border-rule border-b last:border-b-0">
              <button
                type="button"
                onClick={() => pick(row)}
                className="press hover:bg-greenbar flex min-h-11 w-full items-center gap-1 px-3 text-left"
              >
                {/* `যাতায়াত › রিকশা`, the same convention the recent-category
                    chips use. `›` reads as containment in any script and costs
                    one character where a second line would cost a row. */}
                {row.parentName ? (
                  <span className="text-ink-muted shrink-0 truncate text-xs">
                    {row.parentName} ›
                  </span>
                ) : null}
                <span className="text-ink min-w-0 flex-1 truncate text-sm">{nameOf(row)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
