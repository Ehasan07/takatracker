'use client';

import type { MigrationDecision } from '@hishab/core';
import { Check, Layers } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { DECISION_LABELS } from './types';

/**
 * One decision for a whole heading.
 *
 * ## Why this exists at all
 *
 * 296 categories is not 296 decisions. They arrive already grouped the way the
 * other product grouped them — Vehicle, Food & Drinks, Financial expenses — and
 * that grouping is very close to the answer: everything under Vehicle is a
 * sub-category of যাতায়াত, everything under Food & Drinks of খাবার ও বাজার.
 * Deciding by group turns an afternoon into about ten choices.
 *
 * Nothing here is irreversible or hidden: it sets the same field the row's own
 * control sets, every row still shows what it ended up with, and a row can be
 * changed back afterwards. It is a faster way to type, not a different power.
 */
export function GroupHeader({
  group,
  count,
  parents,
  disabled,
  onApply,
  onCreateNow,
  pending,
}: {
  group: string;
  count: number;
  /** Top-level categories of the matching kind, for "all of these, under X". */
  parents: { id: string; name: string }[];
  disabled: boolean;
  onApply: (patch: { decision?: MigrationDecision; targetId?: string | null }) => void;
  /** Create this group's rows now and leave the rest of the batch open. */
  onCreateNow?: () => void;
  /** How many of them are still waiting to be created. */
  pending: number;
}) {
  const [decision, setDecision] = React.useState<MigrationDecision | ''>('');

  return (
    <li className="border-rule bg-greenbar/40 flex flex-col gap-2 border-b px-2 py-2 sm:flex-row sm:items-center sm:gap-3">
      <p className="text-ink flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium">
        <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{group}</span>
        <span className="text-ink-muted">({count})</span>
      </p>

      <div className="flex shrink-0 flex-col gap-2 sm:w-80 sm:flex-row">
        <Select
          aria-label={`${group} — সবগুলোতে`}
          value={decision}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value as MigrationDecision | '';
            setDecision(next);
            /* Applied on choosing, except for the one that needs a second
               answer — a create with no parent is a valid answer, so it goes
               through immediately and the parent control stays for changing it. */
            if (next && next !== 'MERGE') onApply({ decision: next });
          }}
        >
          <option value="">সবগুলোতে একসাথে…</option>
          {(['CREATE', 'SAVINGS', 'INSURANCE', 'LIABILITY', 'RECEIVABLE', 'SKIP'] as const).map(
            (choice) => (
              <option key={choice} value={choice}>
                {DECISION_LABELS[choice]}
              </option>
            ),
          )}
        </Select>

        {decision === 'CREATE' && parents.length > 0 ? (
          <Select
            aria-label={`${group} — সবগুলো কার নিচে`}
            defaultValue=""
            disabled={disabled}
            onChange={(e) => onApply({ decision: 'CREATE', targetId: e.target.value || null })}
          >
            <option value="">সবগুলো কার নিচে?</option>
            {parents.map((parent) => (
              <option key={parent.id} value={parent.id}>
                {parent.name}-এর নিচে
              </option>
            ))}
          </Select>
        ) : null}

        {/* 312 rows is not one sitting. A group decided is a group worth
            keeping, and the batch stays open for the rest. */}
        {onCreateNow && pending > 0 ? (
          <Button variant="ghost" disabled={disabled} onClick={onCreateNow}>
            <Check className="h-4 w-4" aria-hidden />
            এই {pending}টা এখনই তৈরি করুন
          </Button>
        ) : null}
        {pending === 0 ? (
          <span className="text-income inline-flex items-center gap-1 px-2 text-xs">
            <Check className="h-3.5 w-3.5" aria-hidden />
            তৈরি হয়ে গেছে
          </span>
        ) : null}
      </div>
    </li>
  );
}
