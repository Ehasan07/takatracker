'use client';

import type { DatePreference } from '@hishab/core';
import * as React from 'react';
import type { AccountDto } from '@/lib/api';
import { Money } from '@/components/money';
import { Field, Select } from '@/components/ui/field';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { DATE_PREFERENCES, ROLES, type ColumnRole } from './labels';
import { Notice } from './parts';
import type { DisplayRow } from './parse';

/**
 * The screen that decides whether the import is right or wrong.
 *
 * Every column gets a name, and beside it the first rows are shown *as they
 * will be imported* — parsed date, resolved direction, poisha — not as they
 * look in the file. Change a dropdown and the preview changes underneath your
 * finger, because the only way to know a mapping is correct is to see its
 * output. `@hishab/core` does the resolving, which is the same code the server
 * will run, so this is a preview and not an impression.
 */
export function MappingStep({
  headers,
  roles,
  onRoleChange,
  sampleCells,
  datePreference,
  onDatePreferenceChange,
  dateConfident,
  reparsing,
  accounts,
  accountId,
  onAccountChange,
  preview,
  problems,
  warnings,
}: {
  headers: string[];
  roles: ColumnRole[];
  onRoleChange: (index: number, role: ColumnRole) => void;
  /** The first data row, so each dropdown sits next to real content. */
  sampleCells: readonly string[];
  datePreference: DatePreference;
  onDatePreferenceChange: (next: DatePreference) => void;
  /** False when the file never proved which date convention it uses. */
  dateConfident: boolean;
  reparsing: boolean;
  accounts: AccountDto[];
  accountId: string;
  onAccountChange: (id: string) => void;
  preview: DisplayRow[];
  problems: string[];
  warnings: string[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="কোন অ্যাকাউন্টে যাবে" htmlFor="imp-account">
          <Select
            id="imp-account"
            value={accountId}
            onChange={(e) => onAccountChange(e.target.value)}
            required
          >
            <option value="">অ্যাকাউন্ট বেছে নিন</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="তারিখের ধরন" htmlFor="imp-dateorder">
          <Select
            id="imp-dateorder"
            value={datePreference}
            disabled={reparsing}
            onChange={(e) => {
              haptic('select');
              onDatePreferenceChange(e.target.value as DatePreference);
            }}
          >
            {DATE_PREFERENCES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {!dateConfident ? (
        <Notice tone="warn">
          এই ফাইল দেখে বোঝা যায়নি তারিখ কোন নিয়মে লেখা — ০৩/০৪/২০২৬ হতে পারে ৩ এপ্রিল, আবার ৪
          মার্চও। নিচের নমুনার তারিখগুলো আপনার স্টেটমেন্টের সঙ্গে মিলিয়ে নিন।
        </Notice>
      ) : null}

      {problems.map((problem) => (
        <Notice key={problem} tone="bad">
          {problem}
        </Notice>
      ))}

      {warnings.map((warning) => (
        <Notice key={warning} tone="warn">
          {warning}
        </Notice>
      ))}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Left: what each column is. */}
        <section aria-label="কলাম মেলানো" className="flex flex-col gap-2">
          <h3 className="text-ink-muted text-sm font-medium">ফাইলের কলামগুলো কী কী</h3>
          <ul className="divide-rule rounded-card border-rule bg-surface divide-y border">
            {headers.map((header, index) => (
              <li key={`${header}-${index}`} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-ink truncate text-sm font-medium">{header}</p>
                  <p className="text-ink-muted truncate text-xs" title={sampleCells[index] ?? ''}>
                    {sampleCells[index]?.trim() ? sampleCells[index] : 'নমুনা নেই'}
                  </p>
                </div>
                <Select
                  aria-label={`${header} কলামটি কী`}
                  className="w-36 shrink-0 md:w-40"
                  value={roles[index] ?? 'ignore'}
                  onChange={(e) => {
                    haptic('select');
                    onRoleChange(index, e.target.value as ColumnRole);
                  }}
                >
                  {ROLES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </section>

        {/* Right: the same rows, as the ledger will hold them. */}
        <section aria-label="যেভাবে যোগ হবে" className="flex min-w-0 flex-col gap-2">
          <h3 className="text-ink-muted text-sm font-medium">যেভাবে যোগ হবে</h3>
          <div className="rounded-card border-rule bg-surface min-w-0 overflow-x-auto border">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="border-rule text-ink-muted border-b text-left text-xs">
                  <th scope="col" className="px-3 py-2 font-medium">
                    তারিখ
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    বিবরণ
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    টাকার অঙ্ক
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    অবস্থা
                  </th>
                </tr>
              </thead>
              <tbody className="divide-rule divide-y">
                {preview.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-ink-muted px-3 py-6 text-center text-sm">
                      দেখানোর মতো সারি নেই।
                    </td>
                  </tr>
                ) : (
                  preview.map((row) => <PreviewRow key={row.key} row={row} />)
                )}
              </tbody>
            </table>
          </div>
          <p className="text-ink-muted text-xs">
            উপরের ড্রপডাউন বদলালে এই নমুনা সঙ্গে সঙ্গে বদলাবে।
          </p>
        </section>
      </div>
    </div>
  );
}

function PreviewRow({ row }: { row: DisplayRow }) {
  const broken = row.problem !== null;
  return (
    <tr className={cn(broken && 'bg-expense/5', !broken && row.duplicate && 'bg-brass/5')}>
      <td className="text-ink whitespace-nowrap px-3 py-2 align-top">
        {row.date ?? <span className="text-ink-muted">—</span>}
      </td>
      <td className="text-ink max-w-[12rem] truncate px-3 py-2 align-top" title={row.description}>
        {row.description || <span className="text-ink-muted">—</span>}
        {row.reference || row.categoryName ? (
          <span className="text-ink-muted block truncate text-xs">
            {[row.reference, row.categoryName].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right align-top">
        {row.amountMinor === null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <Money minor={row.amountMinor} colored signed className="text-sm" />
        )}
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {broken ? (
          <span className="text-expense">{row.problem}</span>
        ) : row.duplicate ? (
          <span className="text-brass">আগেই খাতায় আছে</span>
        ) : (
          <span className="text-income">যোগ হবে</span>
        )}
      </td>
    </tr>
  );
}
