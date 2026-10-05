'use client';

import { Info } from '@/components/icons';
import * as React from 'react';
import { CategoryOptions } from '@/components/category-options';
import { Money } from '@/components/money';
import { Select } from '@/components/ui/field';
import type { CategoryDto } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import type { ReviewRowModel } from './review';

/**
 * One row of a statement, and the two decisions attached to it.
 *
 * ## Why the whole thing is on one line
 *
 * The same reasoning as `(shell)/migration/decision-row.tsx`, and for the same
 * reason: there can be two hundred of these. Anything that costs a tap to open,
 * a tap to answer and a tap to close is six hundred taps, and the statement
 * stops being finished on the day it is started. So the category is a native
 * `<select>` — one tap on a phone, the platform's own picker, keyboard
 * navigable on a laptop — and the approval is a checkbox, which is the smallest
 * possible yes.
 *
 * ## Why approval is not the same as being importable
 *
 * A row can be perfectly readable and still not be one the person wants. That
 * is the whole point of approving row by row rather than pressing one button
 * for the file: half a Bangladeshi statement is already in the books because
 * the bank sent an SMS at the time, and only the person holding it knows which
 * half.
 *
 * ## Why a flagged row starts unticked
 *
 * Every row that parsed is ticked to begin with, because the ordinary case is
 * "import this statement". A row with a possible duplicate is the exception and
 * starts unticked: leaving it ticked would mean the default action on an
 * ambiguous row is to double it, and the mistake this feature exists to prevent
 * would be one press away. Unticking is reversible in one tap and visible;
 * a doubled entry is neither.
 */
export function ReviewRow({
  row,
  categories,
  onToggle,
  onCategoryChange,
  onExplainDuplicate,
  disabled,
}: {
  row: ReviewRowModel;
  /** Every category in the workspace; the row's own side of the books is picked below. */
  categories: readonly CategoryDto[];
  onToggle: (approved: boolean) => void;
  onCategoryChange: (categoryId: string) => void;
  onExplainDuplicate: () => void;
  disabled: boolean;
}) {
  const checkboxId = `row-${row.key}`;
  const broken = row.problem !== null;
  /* Money in is income and money out is an expense — a bank statement cannot
     file a deposit under a spending head, and offering the whole list would let
     it try. */
  const kind = row.direction === 'IN' ? 'INCOME' : 'EXPENSE';

  return (
    <li
      className={cn(
        'border-rule flex flex-col gap-2 border-b py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3',
        broken && 'opacity-70',
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {broken ? (
          // Nothing to approve: there is no row here, only a line that could
          // not be read. It is still listed, because a silent drop is worse.
          <span aria-hidden className="mt-1 h-4 w-4 shrink-0" />
        ) : (
          <input
            id={checkboxId}
            type="checkbox"
            checked={row.approved}
            disabled={disabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="accent-income mt-1 h-4 w-4 shrink-0 cursor-pointer"
            aria-label={t('import.review.approveRow', 'এই সারিটি যোগ করুন')}
          />
        )}

        <div className="min-w-0 flex-1">
          <label
            htmlFor={broken ? undefined : checkboxId}
            className={cn('flex flex-wrap items-baseline gap-x-2', !broken && 'cursor-pointer')}
          >
            <span className="text-ink text-sm font-medium">
              {row.date ? fmtDate(row.date) : '—'}
            </span>
            <span className="text-ink min-w-0 truncate text-sm" title={row.description}>
              {row.description || t('import.review.noDescription', 'বিবরণ নেই')}
            </span>
          </label>

          {row.reference ? (
            <p className="text-ink-muted truncate text-xs">{row.reference}</p>
          ) : null}

          {broken ? (
            <p className="text-expense text-xs">{row.problem}</p>
          ) : row.matches.length > 0 ? (
            /* The badge and its evidence. It says "possible" and it never says
               anything else — somebody really can withdraw ৳500 twice on the
               same day, and this screen cannot tell that apart from one
               withdrawal recorded twice. */
            <button
              type="button"
              onClick={onExplainDuplicate}
              className="text-brass border-brass/40 mt-1 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
            >
              {t('import.duplicate.badge', 'সম্ভাব্য ডুপ্লিকেট')}
              <Info className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">
                {t('import.duplicate.badgeHelp', 'কীসের সঙ্গে মিলেছে দেখুন')}
              </span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:w-72">
        {row.amountMinor === null ? (
          <span className="text-ink-muted flex-1 text-right text-sm">—</span>
        ) : (
          <Money
            minor={row.direction === 'OUT' ? -row.amountMinor : row.amountMinor}
            colored
            signed
            className="flex-1 text-right text-sm font-semibold"
          />
        )}

        {broken ? null : (
          <Select
            aria-label={t('import.review.categoryFor', 'এই সারির খাত')}
            className="w-40 shrink-0"
            value={row.categoryId}
            disabled={disabled}
            onChange={(e) => onCategoryChange(e.target.value)}
          >
            <option value="">{t('import.review.noCategory', 'খাত ছাড়াই')}</option>
            <CategoryOptions categories={categories} kind={kind} />
          </Select>
        )}
      </div>
    </li>
  );
}
