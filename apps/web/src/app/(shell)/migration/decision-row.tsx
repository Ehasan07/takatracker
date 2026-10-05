'use client';

import type { MigrationDecision } from '@hishab/core';
import { CircleAlert, Pencil } from '@/components/icons';
import * as React from 'react';
import { CategoryOptions } from '@/components/category-options';
import { Input, Select } from '@/components/ui/field';
import type { CategoryDto } from '@/lib/api';
import { useDisplayName } from '@/lib/display-name';
import { ACCOUNT_TYPES, DECISION_LABELS, type MigrationItem } from './types';

/**
 * One staged row and the decision attached to it.
 *
 * ## Why the whole choice is on one line
 *
 * Two hundred of these. Anything that takes a tap to open, a tap to choose and
 * a tap to close is six hundred taps, and the migration stops being finished on
 * the day it is started. So the decision is a native `<select>` — one tap on a
 * phone, keyboard-navigable on a laptop, and it opens the platform's own
 * picker rather than something that has to be reimplemented for both.
 *
 * The second control appears only when the first one needs it: a target to
 * merge into, or a type for an account. A row that needs no second answer shows
 * no second control, which is what keeps a list of two hundred readable.
 */
export function DecisionRow({
  item,
  targets,
  categoryTargets,
  parents,
  disabled,
  onChange,
  onAskDetail,
}: {
  item: MigrationItem;
  /** What an account row could be merged into. Flat: accounts have no tree. */
  targets?: { id: string; name: string }[];
  /**
   * Every category in the workspace — what a category row could be merged into.
   *
   * Whole rather than flattened, because this is the screen that turns a
   * twelve-category workspace into a three-hundred-category one, and a flat
   * alphabetical three hundred is where "Air Filter" sits between "Abir
   * CCJ-01973689593" and "Alarm" with nothing saying it belongs under
   * যাতায়াত. `CategoryOptions` needs the parent links to say so.
   */
  categoryTargets?: readonly CategoryDto[];
  /** Top-level categories of this row's kind — what it could sit under. */
  parents?: { id: string; name: string }[];
  disabled: boolean;
  onChange: (patch: {
    decision?: MigrationDecision;
    targetType?: string;
    targetId?: string;
    name?: string;
  }) => void;
  onAskDetail: () => void;
}) {
  /* The name is editable in place, because "Financial expenses" is the other
     product's English heading over 68 rows and these books are kept in Bengali.
     Renaming after approval means creating the wrong name first and finding it
     again on another screen — thirteen times. */
  const { name: displayName } = useDisplayName();
  const [editing, setEditing] = React.useState(false);
  const shownName = item.targetName?.trim() || item.sourceName;
  const isAccount = item.kind === 'ACCOUNT';
  /* Already in the books. Its controls are frozen because changing a decision
     that has been carried out would say something untrue about what happened. */
  const done = Boolean(item.createdEntityId);
  const frozen = disabled || done;
  /* An account is never a savings plan or a policy: those two exist to rescue a
     *category* that was standing in for one. Offering them here would invite a
     bank account to become a DPS record with no balance. */
  const choices: MigrationDecision[] = isAccount
    ? ['CREATE', 'MERGE', 'LATER', 'SKIP']
    : ['CREATE', 'MERGE', 'SAVINGS', 'INSURANCE', 'LIABILITY', 'PERSON', 'LATER', 'SKIP'];
  /* Which half of the books this row belongs to. Same default the parent picker
     and the server both take when the staged row never said. */
  const mergeKind = item.targetType === 'INCOME' ? 'INCOME' : 'EXPENSE';

  /* A target the kind-filtered list will not contain.
   *
   * Staging matches an imported name against existing categories by name and
   * nothing else, so a খরচ row can arrive already pointed at বাড়ি ভাড়া the
   * *income* category. Silently dropping it from the list would show an empty
   * box over a decision that has in fact been made, and the apply would still
   * carry it out. So it is shown, and it says which side it is on — which is
   * also the first time anybody gets told the match was wrong. */
  const offSideTarget =
    !isAccount && item.targetId
      ? (categoryTargets ?? []).find((c) => c.id === item.targetId && c.kind !== mergeKind)
      : undefined;

  return (
    <li className="border-rule flex flex-col gap-2 border-b py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            defaultValue={shownName}
            aria-label={`${item.sourceName} — নতুন নাম`}
            maxLength={120}
            onBlur={(e) => {
              setEditing(false);
              const next = e.target.value.trim();
              if (next !== shownName) onChange({ name: next });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              /* Escape puts back what was there rather than saving a
                 half-typed name. */
              if (e.key === 'Escape') {
                e.currentTarget.value = shownName;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={frozen}
            className="group flex w-full items-center gap-1.5 text-left"
          >
            <span className="text-ink truncate text-sm font-medium" title={item.sourceName}>
              {shownName}
            </span>
            {/* Said on the row, because deciding a heading decides where a
                hundred others end up. */}
            {item.isGroup ? (
              <span className="text-ink-muted shrink-0 text-xs font-normal">— মূল খাত</span>
            ) : null}
            <Pencil
              className="text-ink-muted h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100"
              aria-hidden
            />
          </button>
        )}

        {done ? (
          <p className="text-income text-xs">✓ তৈরি হয়ে গেছে</p>
        ) : item.skippedReason ? (
          <p className="text-ink-muted text-xs">{item.skippedReason}</p>
        ) : null}

        {/* The name it arrived with, once it is no longer the name it will get —
            so a row stays recognisable against the other product. */}
        {item.targetName?.trim() && item.targetName.trim() !== item.sourceName ? (
          <p className="text-ink-muted truncate text-xs">আগে: {item.sourceName}</p>
        ) : null}
        <p className="text-ink-muted truncate text-xs">
          {item.detail}
          {item.usageCount > 0 ? ` · ${item.usageCount}টি লেনদেন` : ''}
        </p>

        {/* Only where the row raises a question the other product could not
            answer — a credit card's dates, a DPS's instalment. The mark stays
            until it is answered, because a card with no due day silently never
            reminds anybody of anything. */}
        {item.needs ? (
          <button
            type="button"
            onClick={onAskDetail}
            disabled={frozen}
            className={`mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
              item.needs === 'CATEGORY'
                ? 'text-ink-muted border-rule border'
                : item.needsComplete
                  ? 'text-income bg-greenbar'
                  : 'text-expense border-expense/40 border'
            }`}
          >
            {item.needsComplete ? null : <CircleAlert className="h-3.5 w-3.5" aria-hidden />}
            {item.needs === 'CATEGORY'
              ? 'খোঁজার শব্দ'
              : item.needsComplete
                ? 'তথ্য দেওয়া আছে — বদলান'
                : 'বাকি তথ্য দিন'}
          </button>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-2 sm:w-[26rem] sm:flex-row">
        <Select
          aria-label={`${item.sourceName} — কী করা হবে`}
          value={item.decision}
          disabled={disabled}
          onChange={(e) => onChange({ decision: e.target.value as MigrationDecision })}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {DECISION_LABELS[choice]}
            </option>
          ))}
        </Select>

        {item.decision === 'MERGE' ? (
          <Select
            aria-label={`${item.sourceName} — কোনটার সাথে`}
            value={item.targetId ?? ''}
            disabled={frozen}
            /* Marked while it is empty. Choosing "মেলাও" and choosing what to
               merge into are two separate acts, and a row left between them
               does nothing at all when the batch is applied. */
            className={item.targetId ? undefined : 'border-expense'}
            onChange={(e) => onChange({ targetId: e.target.value })}
          >
            <option value="">কোনটার সাথে? বেছে নিন…</option>
            {isAccount ? (
              (targets ?? []).map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))
            ) : (
              <>
                {offSideTarget ? (
                  <option value={offSideTarget.id}>
                    {displayName(offSideTarget)} —{' '}
                    {offSideTarget.kind === 'INCOME' ? 'আয়ের খাত' : 'খরচের খাত'}
                  </option>
                ) : null}
                {/* This row's own side of the books and no other. An income
                    category folded into an expense one is a merge that no
                    report could ever explain, and the other product already
                    told us which side this row is — its own "Income" heading is
                    where `targetType` came from, so it is a fact, not a guess. */}
                <CategoryOptions categories={categoryTargets} kind={mergeKind} />
              </>
            )}
          </Select>
        ) : null}

        {/* Which half of the books this category belongs to.
         *
         * It used to be read off the other product's own heading and never
         * offered — the reasoning being that Wallet had already said which
         * side a row was on, so asking again would be asking a question that
         * was already answered. That holds for most groups and breaks on the
         * ones that are not a side at all: everything under Wallet's
         * "Investments" heading arrives as *spending*, so a dividend, a
         * trading gain and a land share all land in the expense tree, where no
         * report can ever show them as the income they are.
         *
         * The staged value stays the default — it is right far more often than
         * not — but it is now a default rather than a verdict.
         *
         * Changing it clears the parent, because a parent's kind must match its
         * children's: an income row left pointing at an expense heading is a
         * merge the server refuses, and refusing it at apply time means
         * discovering it after 300 other rows have already gone in. */}
        {!isAccount && (item.decision === 'CREATE' || item.decision === 'MERGE') ? (
          <Select
            aria-label={`${item.sourceName} — আয় না খরচ`}
            value={mergeKind}
            disabled={frozen}
            onChange={(e) =>
              onChange({
                targetType: e.target.value,
                targetId: '',
              })
            }
          >
            <option value="EXPENSE">খরচের খাত</option>
            <option value="INCOME">আয়ের খাত</option>
          </Select>
        ) : null}

        {/* A category being created can sit under one that already exists.
            Optional, and blank is the ordinary answer: most rows are their own
            heading. Only two levels are allowed, so this lists top-level
            categories of the same kind and nothing else. */}
        {!isAccount && item.decision === 'CREATE' && parents && parents.length > 0 ? (
          <Select
            aria-label={`${item.sourceName} — কার নিচে`}
            value={item.targetId ?? ''}
            disabled={frozen}
            onChange={(e) => onChange({ targetId: e.target.value })}
          >
            <option value="">নিজেই একটা খাত</option>
            {parents.map((parent) => (
              <option key={parent.id} value={parent.id}>
                {parent.name}-এর নিচে
              </option>
            ))}
          </Select>
        ) : null}

        {isAccount && item.decision === 'CREATE' ? (
          <Select
            aria-label={`${item.sourceName} — ধরন`}
            value={item.targetType ?? 'BANK'}
            disabled={frozen}
            onChange={(e) => onChange({ targetType: e.target.value })}
          >
            {ACCOUNT_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
    </li>
  );
}
