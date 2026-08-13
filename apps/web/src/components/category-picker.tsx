'use client';

/**
 * Choose the খাত a transaction belongs to — and, when that খাত has any, the
 * উপ-খাত inside it.
 *
 * The sheet used to carry one flat `<select>` holding every row the workspace
 * had, parents and children side by side in one list. It saved the right id and
 * told the user nothing: a control reading "Family Hangout" with no sign of the
 * খাত it sits under, at the one moment the two-level tree the categories screen
 * carefully teaches actually has to be understood. So: two controls, and one
 * piece of state behind them.
 *
 *  1. **One id, two boxes.** The caller holds exactly what it will save — the
 *     leaf id — and everything the two boxes show is *derived* from it. There is
 *     no second variable, so "changing the parent must clear a sub-category that
 *     no longer belongs to it" is not a rule enforced by an effect that could be
 *     forgotten; it is a state this component cannot represent. Choosing a
 *     parent writes the parent's id, and the উপ-খাত box derives to empty in the
 *     same render.
 *
 *  2. **The ক্যাটাগরি box lists the children too**, each inside an `<optgroup>`
 *     named after the parent it belongs to. Somebody who thinks "রিকশা" should
 *     not first have to remember that রিকশা lives under যাতায়াত — that is
 *     precisely the knowledge the old control assumed and this one exists to
 *     supply. Picking a child there fills both boxes, and the ক্যাটাগরি box then
 *     reads যাতায়াত: the answer the screenshot could not give.
 *
 *  3. **A search box above two native selects.** The whole tree is in the
 *     selects, where the platform's type-ahead handles it on a desktop and the
 *     OS wheel handles it on a phone — but a wheel through forty rows is slow
 *     when you already know the name, and desktop type-ahead only matches from
 *     the first character of the label.
 *
 *     The search is `CategorySearch`, and it goes through `GET /categories?q=`
 *     rather than filtering the array this component already holds. That is the
 *     whole point: a local filter would look identical and silently lose
 *     Banglish, since `rickshaw` and রিকশা share no characters. The API
 *     transliterates, ranks the workspace's aliases, and pulls a matched child's
 *     parent back in. Nothing in this file filters anything, which is unchanged.
 */

import * as React from 'react';
import type { CategoryDto } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { useDisplayName } from '@/lib/display-name';
import { CategorySearch } from './category-search';
import { Field, Select } from './ui/field';

type Kind = 'INCOME' | 'EXPENSE';

/** A top-level খাত and whatever sits under it. Two levels, never three. */
export interface CategoryGroup {
  parent: CategoryDto;
  children: CategoryDto[];
}

/**
 * Group one kind's flat list the way `(shell)/categories/page.tsx` groups it.
 *
 * A child whose parent is not in the list is treated as a root rather than
 * dropped. That can only happen if the two disagree about `kind`, and a category
 * that has quietly vanished from the picker is a far worse failure than one
 * shown a level too high.
 */
export function groupCategories(categories: readonly CategoryDto[], kind: Kind): CategoryGroup[] {
  const mine = categories.filter((c) => c.kind === kind);
  const ids = new Set(mine.map((c) => c.id));
  const parentOf = (c: CategoryDto): string | null =>
    c.parentId && ids.has(c.parentId) ? c.parentId : null;

  return mine
    .filter((c) => parentOf(c) === null)
    .map((parent) => ({
      parent,
      children: mine.filter((c) => parentOf(c) === parent.id),
    }));
}

/** What the two boxes hold, read back out of the single id being saved. */
export interface CategorySelection {
  /** The top-level খাত, or `''` when nothing is chosen. */
  parentId: string;
  /** `''` whenever the choice is the parent itself. */
  childId: string;
}

export function selectionOf(
  categoryId: string,
  groups: readonly CategoryGroup[],
): CategorySelection {
  for (const group of groups) {
    if (group.parent.id === categoryId) return { parentId: categoryId, childId: '' };
    if (group.children.some((c) => c.id === categoryId)) {
      return { parentId: group.parent.id, childId: categoryId };
    }
  }
  /* An id the list does not know yet — the categories query resolving after the
     sheet opened. Treated as a parent so the box has something to sit on; see
     `unknownName` below for why an unmatched value is not harmless. */
  return { parentId: categoryId, childId: '' };
}

/**
 * The two controls.
 *
 * `categories` is the raw list; the kind filter lives here so that no caller has
 * to remember an income sheet must not offer খরচের খাত.
 */
export function CategoryPicker({
  categories,
  kind,
  value,
  onChange,
  idPrefix,
  unknownName = null,
}: {
  categories: readonly CategoryDto[];
  kind: Kind;
  /** The id that will be saved: a sub-category when one is chosen, else its parent. */
  value: string;
  onChange: (categoryId: string) => void;
  /** Unique per host form, so two pickers on one page keep distinct label ids. */
  idPrefix: string;
  /**
   * Name to stand in for a `value` the list does not contain yet.
   *
   * The accounts `<select>` in the same sheet learned this the hard way: a
   * required control whose value matches no option refuses to submit, silently,
   * with no visible error — and here it would also show an empty box over a
   * transaction that does have a category, inviting somebody to re-pick one.
   */
  unknownName?: string | null;
}) {
  const { name: nameOf } = useDisplayName();
  const groups = React.useMemo(() => groupCategories(categories, kind), [categories, kind]);
  const { parentId, childId } = selectionOf(value, groups);

  const group = groups.find((g) => g.parent.id === parentId) ?? null;
  const children = group?.children ?? [];
  const parentUnknown = parentId !== '' && group === null;

  const categoryFieldId = `${idPrefix}-category`;
  const subFieldId = `${idPrefix}-subcategory`;

  return (
    <>
      {/* Above the selects, because it is the faster path for anybody who knows
          the name — and picking a result fills both boxes below, so the two
          controls agree rather than competing. */}
      <CategorySearch kind={kind} idPrefix={idPrefix} onPick={onChange} />

      <Field label="ক্যাটাগরি" htmlFor={categoryFieldId}>
        <Select
          id={categoryFieldId}
          name="categoryId"
          value={parentId}
          /* Required, and the placeholder carries the empty value, so the
             browser refuses the save before the request is built. The sheet
             repeats the refusal in words for anyone whose browser does not. */
          required
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">বেছে নিন</option>
          {parentUnknown ? <option value={parentId}>{unknownName ?? '…'}</option> : null}
          {groups.map(({ parent, children: kids }) => (
            <React.Fragment key={parent.id}>
              <option value={parent.id}>{nameOf(parent)}</option>
              {/* Children in document order right below their parent, so the
                  dropdown reads as the tree it is. The group's own name is on
                  the heading because a bare "রিকশা" three rows down from
                  যাতায়াত is exactly the ambiguity being fixed. */}
              {kids.length > 0 ? (
                <optgroup label={`${nameOf(parent)}-এর উপ-খাত`}>
                  {kids.map((child) => (
                    <option key={child.id} value={child.id}>
                      {nameOf(child)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </React.Fragment>
          ))}
        </Select>
      </Field>

      {/* Only when there is something to choose. A box offering nothing but
          "কোনোটি নয়" teaches a user that sub-categories are broken, and on a
          320px sheet it costs a row of the screen to do it. */}
      {group && children.length > 0 ? (
        <Field label="উপ-খাত" htmlFor={subFieldId}>
          <Select
            id={subFieldId}
            name="subCategoryId"
            value={childId}
            /* Empty means "the parent on its own", which is what `value` goes
               back to — never `''`, or clearing the উপ-খাত would clear the
               required ক্যাটাগরি with it. */
            onChange={(e) => onChange(e.target.value || parentId)}
          >
            <option value="">কোনোটি নয়</option>
            {children.map((child) => (
              <option key={child.id} value={child.id}>
                {nameOf(child)}
              </option>
            ))}
          </Select>
          <p className="text-ink-muted text-xs">
            ঐচ্ছিক। উপ-খাত দিলেও প্রতিবেদনে {kind === 'INCOME' ? 'আয়টি' : 'খরচটি'}{' '}
            {nameOf(group.parent)}-এর মোটের সঙ্গেই যোগ হবে।
          </p>
        </Field>
      ) : null}
    </>
  );
}

/**
 * The accelerator above the form: recent categories first, then the rest.
 *
 * Most entries are made from here, so a child chip has to say which খাত it
 * belongs to on the chip itself. It does that with a prefix — `যাতায়াত ›
 * রিকশা` — and not with a second line, for three reasons:
 *
 *  - The strip sits directly under the amount and the on-screen keypad, the two
 *    things a phone can least afford to have pushed down. Two-line chips double
 *    its height for every row, including the parents that need no second line.
 *  - `›` reads as containment in any script, needs no translating, and costs one
 *    character. Bengali is left-to-right, so parent-then-child also matches the
 *    order the ক্যাটাগরি and উপ-খাত boxes are read in below.
 *  - The parent goes first, dimmed. The strip scrolls rather than truncating, so
 *    nothing is cut; dimming keeps the child the word the eye lands on while the
 *    parent is still there to be read — which is the whole complaint.
 *
 * Tapping any chip writes one id, so a child chip fills both boxes below by the
 * same derivation everything else here uses.
 */
export function CategoryChips({
  categories,
  kind,
  recentIds,
  value,
  onChange,
  max = 8,
}: {
  categories: readonly CategoryDto[];
  kind: Kind;
  /** Categories used most recently, most recent first. */
  recentIds: readonly string[];
  value: string;
  onChange: (categoryId: string) => void;
  max?: number;
}) {
  const { name: nameOf } = useDisplayName();
  const shown = React.useMemo(() => {
    const groups = groupCategories(categories, kind);
    /* Built off the same grouping as the selects, so a chip and a box can never
       disagree about who a child's parent is. */
    const parentNameOf = new Map<string, string>();
    const flat: CategoryDto[] = [];
    for (const { parent, children } of groups) {
      flat.push(parent);
      for (const child of children) {
        parentNameOf.set(child.id, nameOf(parent));
        flat.push(child);
      }
    }

    const byId = new Map(flat.map((c) => [c.id, c]));
    const recent = recentIds
      .map((id) => byId.get(id))
      .filter((c): c is CategoryDto => c !== undefined);
    const recentSet = new Set(recent.map((c) => c.id));
    const rest = flat.filter((c) => !recentSet.has(c.id));

    return [...recent, ...rest]
      .slice(0, max)
      .map((category) => ({ category, parentName: parentNameOf.get(category.id) ?? null }));
  }, [categories, kind, recentIds, max, nameOf]);

  if (shown.length === 0) return null;

  return (
    <div className="chip-strip" aria-label="দ্রুত বাছাই">
      {shown.map(({ category, parentName }) => {
        const name = nameOf(category);
        const on = value === category.id;
        return (
          <button
            key={category.id}
            type="button"
            onClick={() => {
              haptic('tap');
              onChange(category.id);
            }}
            aria-pressed={on}
            /* Spelled out for a screen reader, which gets no help from a
               chevron. The visible chip says the same thing in less room. */
            aria-label={parentName ? `${parentName}-এর ভেতরে ${name}` : name}
            className={cn(
              'press min-h-9 rounded-full px-3 text-xs',
              on ? 'bg-income font-medium text-white' : 'border-rule text-ink border',
            )}
          >
            {parentName ? <span className="opacity-60">{parentName} › </span> : null}
            {name}
          </button>
        );
      })}
    </div>
  );
}
