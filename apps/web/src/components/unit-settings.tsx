'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from '@/components/icons';
import * as React from 'react';
import {
  COMMON_QUANTITY_UNITS,
  MAX_CUSTOM_UNITS,
  MAX_UNIT_LENGTH,
  UNIT_CATALOGUE,
  normaliseUnit,
  shippedUnits,
  unitGroups,
} from '@hishab/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { fetchWorkspaceSettings, workspaceSettingsKey } from '@/lib/workspace-units';

/**
 * The units this workspace adds to the quantity field's suggestions.
 *
 * ## What this screen does not do
 *
 * It does not decide what can be saved. `Transaction.quantityUnit` is free text
 * and stays free text: a unit typed straight into the entry sheet and never
 * added here works exactly as before. This list is the dropdown, nothing more.
 *
 * That distinction is worth being loud about on the screen itself, because a
 * settings page listing units looks exactly like a settings page defining the
 * permitted ones — and somebody who believes the second will come here first
 * every time they meet a new unit, which is slower than just typing it.
 *
 * ## Why removing is safe
 *
 * Removing a unit changes what the dropdown offers and nothing else. Rows
 * already saved in গজ keep their গজ, and the পরিমাণ report keeps grouping them,
 * because the report reads the transactions and not this list. There is
 * therefore no confirmation on the remove button: it is not a destructive
 * action, and a dialog would say otherwise.
 */

interface SettingsDto {
  quantityUnits: string[];
}

const bn = (value: number | string): string => fmtNumber(String(value));

/** One per unit, not per spelling — `shippedUnits()` counts কেজি and kg twice. */
const SHIPPED_COUNT = UNIT_CATALOGUE.reduce((total, group) => total + group.units.length, 0);

export function UnitSettings() {
  const queryClient = useQueryClient();
  const [typed, setTyped] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const settings = useQuery({
    queryKey: workspaceSettingsKey,
    queryFn: fetchWorkspaceSettings,
    staleTime: 30 * 60_000,
    retry: false,
  });

  const units = settings.data?.quantityUnits ?? [];

  const save = useMutation({
    mutationFn: (next: string[]) =>
      api<SettingsDto>('/workspace/settings', {
        method: 'PATCH',
        body: { quantityUnits: next },
      }),
    /* The server's cleaned list wins — it dropped the duplicates and the
       overlong entries, so writing the submitted array into the cache instead
       would show a row that is not stored and vanishes on the next load. */
    onSuccess: (data) => {
      haptic('success');
      queryClient.setQueryData(workspaceSettingsKey, data);
    },
    onError: (err) => {
      haptic('warn');
      setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি');
    },
  });

  const typedName = typed.trim().replace(/\s+/g, ' ');
  const key = normaliseUnit(typedName);
  /* The whole shipped catalogue, both languages — not just the eight
     shortcuts. The API drops a duplicate silently, so a check against a shorter
     list would leave the button enabled, accept the tap and show nothing. */
  const isShipped = shippedUnits().some((u) => normaliseUnit(u) === key);
  const isMine = units.some((u) => normaliseUnit(u) === key);
  const isFull = units.length >= MAX_CUSTOM_UNITS;
  const canAdd = typedName !== '' && !isShipped && !isMine && !isFull;

  const add = (): void => {
    if (!canAdd) return;
    setError(null);
    save.mutate([...units, typedName]);
    setTyped('');
  };

  const remove = (unit: string): void => {
    haptic('tap');
    setError(null);
    save.mutate(units.filter((each) => each !== unit));
  };

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink-muted text-sm font-medium">পরিমাণের একক</h2>
      <p className="text-ink-muted mt-1 text-sm">
        লেনদেনে পরিমাণ লেখার সময় যে এককগুলো তালিকায় আসবে। কেজি-লিটার থেকে মণ, ভরি, কাঠা, বিঘা,
        পাউন্ড, গ্যালন — {bn(SHIPPED_COUNT)}টি একক সবার জন্যই থাকে। এর বাইরে কিছু লাগলে এখানে যোগ
        করুন।
      </p>
      {/* Said plainly, because a list of units looks like a list of *permitted*
          units, and believing that costs a trip to this screen every time
          somebody meets a new one. */}
      <p className="text-ink-muted mt-1 text-xs">
        এখানে যোগ না করলেও চলবে — লেনদেনের ঘরে যেকোনো একক সরাসরি লিখতে পারেন। এই তালিকা শুধু টাইপিং
        বাঁচায়।
      </p>

      {/* Folded away by default. Fifty-six chips is not a list somebody reads;
          it is a wall they scroll past to reach the box they came for. Open,
          it answers the only question this screen is asked — "is the one I
          need already here?" — grouped the way the picker groups it. */}
      <details className="border-rule mt-3 rounded-md border">
        <summary className="press text-ink-muted flex min-h-11 cursor-pointer items-center px-3 text-sm">
          আগে থেকেই আছে এমন একক দেখুন
        </summary>
        <div className="space-y-3 px-3 pb-3">
          {unitGroups('bn').map((group) => (
            <div key={group.label}>
              <p className="text-ink-muted text-xs font-medium">{group.label}</p>
              <p className="text-ink-muted mt-0.5 text-xs">{group.units.join(' · ')}</p>
            </div>
          ))}
        </div>
      </details>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {COMMON_QUANTITY_UNITS.map((unit) => (
          <li
            key={unit}
            className="border-rule text-ink-muted flex min-h-9 items-center rounded-full border px-3 text-xs"
          >
            {unit}
          </li>
        ))}
        {units.map((unit) => (
          <li key={unit}>
            <span className="border-brand bg-brand-tint text-ink flex min-h-9 items-center gap-1 rounded-full border pl-3 pr-1 text-xs">
              <span className="max-w-32 truncate">{unit}</span>
              <button
                type="button"
                onClick={() => remove(unit)}
                disabled={save.isPending}
                aria-label={`${unit} এককটি সরান`}
                className="press hover:bg-brand/20 flex h-7 w-7 items-center justify-center rounded-full disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          /* গজ, ভরি and স্ট্রিপ used to be the examples here and all three now
             ship, so the placeholder was telling people to add what they
             already had. */
          placeholder="যেমন তোলা, খাঁচা, ফাইল"
          maxLength={MAX_UNIT_LENGTH}
          aria-label="নতুন একক"
          className="min-w-40 flex-1"
        />
        <Button type="submit" disabled={!canAdd || save.isPending}>
          <Plus className="h-4 w-4" aria-hidden />
          যোগ করুন
        </Button>
      </form>

      {/* Why the button is off, rather than an error after pressing it. */}
      {typedName !== '' && isShipped ? (
        <p className="text-ink-muted mt-2 text-xs">“{typedName}” তালিকায় আগে থেকেই আছে।</p>
      ) : typedName !== '' && isMine ? (
        <p className="text-ink-muted mt-2 text-xs">“{typedName}” আপনি আগেই যোগ করেছেন।</p>
      ) : isFull ? (
        <p className="text-ink-muted mt-2 text-xs">
          সর্বোচ্চ {bn(MAX_CUSTOM_UNITS)}টি একক যোগ করা যায়। নতুন একটি যোগ করতে আগে একটি সরান।
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-expense mt-2 text-sm">
          {error}
        </p>
      ) : null}

      {settings.isError ? (
        <p className="text-ink-muted mt-2 text-xs">
          তালিকা আনা যায়নি। লেনদেনের ঘরে সাধারণ এককগুলো ঠিকই দেখাবে।
        </p>
      ) : null}
    </section>
  );
}
