'use client';

/**
 * The one way this app puts a category tree inside a `<select>`.
 *
 * ## The problem it exists for
 *
 * A workspace that has taken an import has three hundred categories. Rendered
 * as one flat alphabetical list — which is what five separate screens each did,
 * in five slightly different ways — "Air Filter" sits between "Abir
 * CCJ-01973689593" and "Alarm" and nothing on screen says that it lives under
 * যাতায়াত, or that Abir is a person and Alarm is a part. Three hundred rows of
 * that is not a picker; it is a haystack with a save button.
 *
 * ## Why `<optgroup>` and not a custom dropdown
 *
 * Because it is the platform's own answer to exactly one level of hierarchy,
 * and it is the only one that survives the places this app is actually used:
 *
 * - iOS and Android render `<optgroup>` as section headings inside the native
 *   wheel. A div-based listbox renders as a div-based listbox, and on a phone
 *   that means losing the OS picker, its momentum scroll and its type-ahead.
 * - A screen reader announces the group name with the option, so "রিকশা" is
 *   heard as "যাতায়াত, রিকশা" without anything having to fake an `aria-label`.
 * - `decision-row.tsx` spells out the other half of this: two hundred rows of
 *   anything that costs a tap to open and a tap to close is six hundred taps.
 *   A native select is one tap.
 *
 * So nothing here is a component with a popup. It is a set of `<option>` and
 * `<optgroup>` elements that any existing `<Select>` can hold, which is also why
 * every call site kept its own label, placeholder, validation and width.
 *
 * ## The shape of the list
 *
 *  1. **One group per top-level category that has children**, headed by the
 *     parent's own name.
 *  2. **The parent is the first row inside its own group.** It is a category
 *     people file things under, so it has to be choosable; putting it above the
 *     heading instead — which is what `category-picker.tsx` used to do — reads
 *     as a row belonging to nothing.
 *  3. **Children keep their own bare name.** The heading already said যাতায়াত;
 *     repeating it on every row (`যাতায়াত › রিকশা`, the old convention here)
 *     spends the width twice and truncates the half that distinguishes them.
 *  4. **Childless top-level categories share one group at the end.** Forty
 *     groups of one is forty headings that say nothing. The tail is deliberate:
 *     a heading that is not the name of a real category should not sort in
 *     among ones that are, and the trees are what somebody scrolling is looking
 *     for. When there are no trees at all — a fresh workspace, whose seeded
 *     categories are all top-level — the heading is dropped entirely rather
 *     than filed under itself.
 *
 * ## Language and order
 *
 * `useDisplayName`, never `c.name` and never `c.nameBn ?? c.name`. The API sends
 * both names and `name` is the English one, so a list built from it read
 * `Food & groceries` on a workspace where every other control read খাবার ও
 * বাজার — a bug that has already been fixed once, in this app's split sheet, and
 * whose whole point is that it comes back the moment somebody writes a sixth
 * copy of this loop. `compare` is the pair that hook returns for exactly this:
 * it is `localeCompare` in the workspace's own language, so the labels and the
 * order agree about which alphabet they are in.
 */

import * as React from 'react';
import type { CategoryDto } from '@/lib/api';
import { useDisplayName } from '@/lib/display-name';
import { t } from '@/lib/t';

export type CategoryKind = 'INCOME' | 'EXPENSE';

/**
 * Which categories a picker may offer.
 *
 * There is no default, on purpose: an income category offered where an expense
 * belongs is a save the server refuses, or worse, accepts into the wrong half of
 * every report. Making the caller say which side it is on means the question
 * cannot be skipped by omission.
 *
 * `'ALL'` is for the controls that are not filing anything — the transactions
 * filter, which has to be able to ask for either side. Never use it on a form
 * that writes.
 */
export type CategoryScope = CategoryKind | 'ALL';

/** A top-level খাত and whatever sits under it. Two levels, never three. */
export interface CategoryGroup {
  parent: CategoryDto;
  children: CategoryDto[];
}

/**
 * Group a flat list the way `(shell)/categories/page.tsx` groups it.
 *
 * Order is the API's own (`sortOrder`), untouched — `CategoryChips` reads this
 * to decide which categories are worth a chip, and that is a different question
 * from what a dropdown should be sorted by. The alphabetising happens in
 * `useCategoryOptionGroups`, where it is about reading and not about ranking.
 *
 * A child whose parent is not in the list is treated as a root rather than
 * dropped. That can only happen if the two disagree about `kind`, and a category
 * that has quietly vanished from the picker is a far worse failure than one
 * shown a level too high.
 */
export function groupCategories(
  categories: readonly CategoryDto[],
  scope: CategoryScope,
): CategoryGroup[] {
  const mine = scope === 'ALL' ? [...categories] : categories.filter((c) => c.kind === scope);
  const ids = new Set(mine.map((c) => c.id));
  const parentOf = (c: CategoryDto): string | null =>
    c.parentId && ids.has(c.parentId) ? c.parentId : null;

  /* One pass to bucket the children, rather than a scan of the whole list per
     parent. That was O(n²), and n is three hundred on a workspace that has
     taken an import — 90,000 comparisons, paid again by every one of the two
     hundred rows on the migration screen. */
  const childrenOf = new Map<string, CategoryDto[]>();
  const roots: CategoryDto[] = [];
  for (const category of mine) {
    const parentId = parentOf(category);
    if (parentId === null) {
      roots.push(category);
      continue;
    }
    const kids = childrenOf.get(parentId);
    if (kids) kids.push(category);
    else childrenOf.set(parentId, [category]);
  }

  return roots.map((parent) => ({ parent, children: childrenOf.get(parent.id) ?? [] }));
}

/** One `<optgroup>`'s worth: a heading, and the rows under it. */
export interface CategoryOptionGroup {
  /** Stable React key. The parent's id, or the sentinel for the childless tail. */
  key: string;
  /** `null` means "render these rows bare" — see rule 4 above. */
  label: string | null;
  options: { id: string; label: string }[];
}

/** Cannot collide with a category id, which is a cuid. */
const SOLO_KEY = 'solo:childless';

/**
 * One shared empty array, so a query that has not answered yet keeps a stable
 * reference.
 *
 * `categories.data ?? []` at a call site builds a new array on every render,
 * which defeats the memo below and re-groups and re-sorts three hundred rows on
 * every keystroke of whatever form the picker is sitting in. Taking
 * `undefined` here instead means no call site can get that wrong.
 */
const NONE: readonly CategoryDto[] = [];

/**
 * The grouped, sorted, workspace-language list behind every category `<select>`.
 *
 * Exported separately from the renderer because a caller may need the data
 * rather than the markup — anything that has to know whether the list is empty
 * before it decides to show a control at all.
 */
export function useCategoryOptionGroups(
  categories: readonly CategoryDto[] | undefined,
  scope: CategoryScope,
): CategoryOptionGroup[] {
  const { name, compare } = useDisplayName();
  const rows = categories ?? NONE;

  return React.useMemo(() => {
    const groups = groupCategories(rows, scope);

    const trees = groups
      .filter((g) => g.children.length > 0)
      .sort((a, b) => compare(a.parent, b.parent));
    const childless = groups
      .filter((g) => g.children.length === 0)
      .map((g) => g.parent)
      .sort(compare);

    const out: CategoryOptionGroup[] = trees.map(({ parent, children }) => ({
      key: parent.id,
      label: name(parent),
      options: [
        /* The parent first and inside its own group: it is a real choice, and
           the group is the only thing on screen saying so. */
        { id: parent.id, label: name(parent) },
        ...[...children].sort(compare).map((child) => ({ id: child.id, label: name(child) })),
      ],
    }));

    if (childless.length > 0) {
      out.push({
        key: SOLO_KEY,
        /* No heading when there is nothing to distinguish these from. A single
           `একক খাত` over the entire list explains nothing and costs a row. */
        label: trees.length > 0 ? t('entry.soloCategories', 'একক খাত') : null,
        options: childless.map((c) => ({ id: c.id, label: name(c) })),
      });
    }

    return out;
  }, [rows, scope, name, compare]);
}

/**
 * The options themselves, for dropping straight inside an existing `<Select>`.
 *
 * Deliberately not a `<Select>`: every call site has its own label, its own
 * placeholder row, its own `required`, its own width and — in the migration
 * screen — its own red border while empty. A component that owned the select
 * would have to grow a prop for each of those, and the first one it did not have
 * would send somebody back to hand-rolling the loop.
 */
export function CategoryOptions({
  categories,
  kind,
}: {
  /** Pass `query.data` straight in — `undefined` renders nothing. See `NONE`. */
  categories: readonly CategoryDto[] | undefined;
  /** No default. See `CategoryScope`. */
  kind: CategoryScope;
}): React.ReactElement {
  const groups = useCategoryOptionGroups(categories, kind);

  return (
    <>
      {groups.map((group) => {
        const rows = group.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ));
        return group.label === null ? (
          <React.Fragment key={group.key}>{rows}</React.Fragment>
        ) : (
          <optgroup key={group.key} label={group.label}>
            {rows}
          </optgroup>
        );
      })}
    </>
  );
}
