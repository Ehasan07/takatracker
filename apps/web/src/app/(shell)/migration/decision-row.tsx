'use client';

import type { MigrationDecision } from '@hishab/core';
import { CircleAlert } from 'lucide-react';
import * as React from 'react';
import { Select } from '@/components/ui/field';
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
  disabled,
  onChange,
  onAskDetail,
}: {
  item: MigrationItem;
  /** What this row could be merged into — accounts or categories, already filtered. */
  targets: { id: string; name: string }[];
  disabled: boolean;
  onChange: (patch: {
    decision?: MigrationDecision;
    targetType?: string;
    targetId?: string;
  }) => void;
  onAskDetail: () => void;
}) {
  const isAccount = item.kind === 'ACCOUNT';
  /* An account is never a savings plan or a policy: those two exist to rescue a
     *category* that was standing in for one. Offering them here would invite a
     bank account to become a DPS record with no balance. */
  const choices: MigrationDecision[] = isAccount
    ? ['CREATE', 'MERGE', 'SKIP']
    : ['CREATE', 'MERGE', 'SAVINGS', 'INSURANCE', 'SKIP'];

  return (
    <li className="border-rule flex flex-col gap-2 border-b py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-ink truncate text-sm font-medium" title={item.sourceName}>
          {item.sourceName}
        </p>
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
            disabled={disabled}
            className={`mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
              item.needsComplete
                ? 'text-income bg-greenbar'
                : 'text-expense border-expense/40 border'
            }`}
          >
            {item.needsComplete ? null : <CircleAlert className="h-3.5 w-3.5" aria-hidden />}
            {item.needsComplete ? 'তথ্য দেওয়া আছে — বদলান' : 'বাকি তথ্য দিন'}
          </button>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-2 sm:w-80 sm:flex-row">
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
            disabled={disabled}
            /* Marked while it is empty. Choosing "মেলাও" and choosing what to
               merge into are two separate acts, and a row left between them
               does nothing at all when the batch is applied. */
            className={item.targetId ? undefined : 'border-expense'}
            onChange={(e) => onChange({ targetId: e.target.value })}
          >
            <option value="">কোনটার সাথে? বেছে নিন…</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </Select>
        ) : null}

        {isAccount && item.decision === 'CREATE' ? (
          <Select
            aria-label={`${item.sourceName} — ধরন`}
            value={item.targetType ?? 'BANK'}
            disabled={disabled}
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
