'use client';

import * as React from 'react';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import type { CategoryDto } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';
import { bnNum } from './labels';
import { Notice } from './parts';
import { DuplicateSheet } from './duplicate-sheet';
import { ReviewRow } from './review-row';
import type { Review, ReviewRowModel } from './review';
import type { DuplicateScope } from './statement-types';

/**
 * The list every statement ends at: one line per row, approved one at a time.
 *
 * ## Why a list of two hundred and not a summary
 *
 * Because the answer is different for every row. Half a Bangladeshi statement
 * is usually already in the books — the bank sent an SMS at the time and
 * somebody recorded it — and the other half never sent one and is missing. No
 * count at the top of the screen can express that, and no single button can
 * act on it. The person holding the statement is the only one who knows, so
 * the screen's job is to lay the rows out and get out of the way.
 *
 * ## The three controls, and nothing else
 *
 * Tick the row. Pick its category. Look at what it matched. There is no merge,
 * no "skip all duplicates", no bulk resolve — every one of those would be the
 * app making the decision it has just admitted it cannot make.
 *
 * The two bulk buttons that *are* here only set ticks, which is the reversible
 * half, and "সবগুলো বাছাই" deliberately does not touch the flagged rows: a
 * control that ticks everything including the warnings is the same auto-import
 * wearing a different hat.
 */
export function ReviewStep({
  review,
  categories,
  scope,
  disabled,
  onToggle,
  onToggleAllClean,
  onUntickAll,
  onCategoryChange,
}: {
  review: Review;
  categories: readonly CategoryDto[];
  scope: DuplicateScope;
  disabled: boolean;
  onToggle: (lineNumber: number, approved: boolean) => void;
  onToggleAllClean: () => void;
  onUntickAll: () => void;
  onCategoryChange: (lineNumber: number, categoryId: string) => void;
}) {
  const [explaining, setExplaining] = React.useState<ReviewRowModel | null>(null);
  const [onlyFlagged, setOnlyFlagged] = React.useState(false);

  const shown = onlyFlagged ? review.rows.filter((row) => row.matches.length > 0) : review.rows;

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-2">
        <Count
          label={t('import.review.countApproved', 'বাছাই করা')}
          value={review.counts.approved}
          tone="text-income"
        />
        <Count
          label={t('import.review.countFlagged', 'সম্ভাব্য ডুপ্লিকেট')}
          value={review.counts.flagged}
          tone="text-brass"
        />
        <Count
          label={t('import.review.countBroken', 'পড়া যায়নি')}
          value={review.counts.broken}
          tone="text-expense"
        />
      </dl>

      {review.counts.flagged > 0 ? (
        <Notice tone="warn">
          {t(
            'import.review.flaggedNotice',
            'কিছু সারি খাতায় আগে থেকেই থাকা লেনদেনের সঙ্গে মিলে গেছে — একই দিন, একই অ্যাকাউন্ট, একই অঙ্ক। সেগুলো আগে থেকে বাছাই করা নেই। ⓘ চেপে মিলিয়ে দেখে তবেই বাছুন।',
          )}
        </Notice>
      ) : null}

      {scope === 'ALL_ACCOUNTS' ? (
        <p className="text-ink-muted text-xs">
          {t(
            'import.review.scopeAll',
            'উপরে কোন অ্যাকাউন্টে যাবে সেটা বেছে নিলে ডুপ্লিকেট খোঁজা আরও নির্দিষ্ট হবে — এখন সব অ্যাকাউন্টে খোঁজা হচ্ছে।',
          )}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={disabled} onClick={onToggleAllClean}>
          {t('import.review.tickClean', 'যেগুলোতে সতর্কতা নেই সব বাছাই')}
        </Button>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onUntickAll}>
          {t('import.review.untickAll', 'সব বাদ')}
        </Button>
        {review.counts.flagged > 0 ? (
          <label className="text-ink-muted ml-auto flex min-h-11 cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={onlyFlagged}
              onChange={(e) => {
                haptic('select');
                setOnlyFlagged(e.target.checked);
              }}
              className="accent-brass h-4 w-4"
            />
            {t('import.review.onlyFlagged', 'শুধু সম্ভাব্য ডুপ্লিকেট দেখান')}
          </label>
        ) : null}
      </div>

      <ul className="rounded-card border-rule bg-surface max-h-[32rem] overflow-y-auto border px-3">
        {shown.length === 0 ? (
          <li className="text-ink-muted py-6 text-center text-sm">
            {t('import.review.empty', 'দেখানোর মতো সারি নেই।')}
          </li>
        ) : (
          shown.map((row) => (
            <ReviewRow
              key={row.key}
              row={row}
              categories={categories}
              disabled={disabled}
              onToggle={(approved) => onToggle(row.lineNumber, approved)}
              onCategoryChange={(categoryId) => onCategoryChange(row.lineNumber, categoryId)}
              onExplainDuplicate={() => setExplaining(row)}
            />
          ))
        )}
      </ul>

      <div className="border-rule flex items-baseline justify-between gap-2 border-t pt-3">
        <span className="text-ink-muted text-sm">
          {t('import.review.netLabel', 'বাছাই করা সারিগুলোর মোট')}
        </span>
        <Money minor={review.netMinor} colored signed className="text-base font-semibold" />
      </div>

      {explaining ? (
        <DuplicateSheet
          open
          onOpenChange={(open) => {
            if (!open) setExplaining(null);
          }}
          rowLabel={`${explaining.date ?? ''} · ${explaining.description}`.trim()}
          matches={explaining.matches}
          moreCount={explaining.moreCount}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted truncate text-xs">{label}</dt>
      <dd className={`text-lg font-semibold ${tone}`}>{bnNum(value)}</dd>
    </div>
  );
}
