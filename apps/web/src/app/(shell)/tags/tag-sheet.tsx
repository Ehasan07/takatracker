'use client';

/** Create a tag, or rename, recolour and re-word an existing one. */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { ApiError, api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { useDisplayName } from '@/lib/display-name';
import { invalidateTagData } from './queries';
import { DEFAULT_TAG_COLOUR, TAG_COLOURS, safeColour, type TagDto } from './types';

export function TagSheet({
  open,
  editing,
  onOpenChange,
  onSaved,
  onDelete,
}: {
  open: boolean;
  editing: TagDto | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (tag: TagDto) => void;
  /**
   * Asks the caller for its confirmation sheet; this component never deletes.
   *
   * Optional because the picker mounts this sheet too, to make a tag mid-entry.
   * There is nothing to delete there — the tag is one keystroke old — and a bin
   * inside the transaction being written is a trap rather than a shortcut.
   */
  onDelete?: (tag: TagDto) => void;
}) {
  const queryClient = useQueryClient();
  const { name: nameOf } = useDisplayName();
  /* Two boxes, two columns, and neither ever written from the other's value.
     One box that wrote both — `{ name, nameBn: name }` — was fine while every
     screen was Bengali and became a data loss the moment the box could prefill
     with the English name: saving an untouched tag would overwrite the Bengali
     one with it. */
  const [name, setName] = React.useState('');
  const [nameEn, setNameEn] = React.useState('');
  const [colour, setColour] = React.useState<string | null>(DEFAULT_TAG_COLOUR);
  /* One box, comma separated, prefilled with what is stored: `PATCH` replaces
     the list whole, so a blind save has to send back what it was shown. */
  const [aliases, setAliases] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName(editing ? (editing.nameBn ?? editing.name) : '');
    /* Empty when the two columns hold the same string, which is what a tag made
       before this box existed looks like. Showing the Bengali name in a box
       labelled "ইংরেজি নাম" would be claiming an English name was set. */
    setNameEn(editing && editing.name !== (editing.nameBn ?? editing.name) ? editing.name : '');
    setColour(editing ? safeColour(editing.color) : DEFAULT_TAG_COLOUR);
    setAliases(editing ? editing.searchAliases.join(', ') : '');
    setError(null);
  }, [open, editing]);

  const save = useMutation({
    mutationFn: () => {
      /* No English name given means the two mirror, exactly as every tag made
         before this box did. `name` is NOT NULL, so it can never be the empty
         string. */
      const body = {
        name: nameEn.trim() || name,
        nameBn: name,
        color: colour,
        searchAliases: aliases,
      };
      return editing
        ? api<TagDto>(`/tags/${editing.id}`, { method: 'PATCH', body })
        : api<TagDto>('/tags', { method: 'POST', body });
    },
    onSuccess: (tag) => {
      haptic('success');
      /* A rename or a recolour changes every chip already drawn in the khata and
         every row of the by-tag report, not only this list. */
      invalidateTagData(queryClient);
      onSaved?.(tag);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'ট্যাগ সম্পাদনা' : 'নতুন ট্যাগ'}
      description={editing ? nameOf(editing) : 'কার জন্য বা কোন কাজে — যেমন পারিবারিক, রমজান'}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <Field label="নাম" htmlFor="tag-name">
          <Input
            id="tag-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            maxLength={60}
            placeholder="যেমন: শ্বশুরবাড়ি"
          />
        </Field>

        <Field label="ইংরেজি নাম (ঐচ্ছিক)" htmlFor="tag-name-en">
          <Input
            id="tag-name-en"
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            maxLength={60}
            placeholder="In-laws"
          />
        </Field>
        <p className="text-ink-muted -mt-2 text-xs">
          অ্যাপ ইংরেজিতে দেখলে এই নামটি দেখাবে। না দিলে উপরের নামটিই থাকবে।
        </p>

        <div className="flex flex-col gap-1.5">
          <span className="text-ink text-sm font-medium" id="tag-colour-label">
            রঙ
          </span>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="tag-colour-label">
            {TAG_COLOURS.map(([hex, label]) => (
              <button
                key={hex}
                type="button"
                aria-label={label}
                aria-pressed={colour === hex}
                onClick={() => {
                  haptic('tap');
                  setColour(hex);
                }}
                className={cn(
                  'press touch-target flex items-center justify-center rounded-md border-2',
                  colour === hex ? 'border-ink' : 'border-transparent',
                )}
              >
                <span aria-hidden className="h-6 w-6 rounded-full" style={{ background: hex }} />
              </button>
            ))}
            <button
              type="button"
              aria-label="রঙ নেই"
              aria-pressed={colour === null}
              onClick={() => {
                haptic('tap');
                setColour(null);
              }}
              className={cn(
                'press touch-target text-ink-muted flex items-center justify-center rounded-md border-2',
                colour === null ? 'border-ink' : 'border-transparent',
              )}
            >
              <Ban className="h-5 w-5" aria-hidden />
            </button>
          </div>
          {/* Colour is decoration here and nowhere a signal on its own: every
              chip in the app prints the name beside the dot. */}
          <p className="text-ink-muted text-xs">
            রঙ শুধু চিনতে সাহায্য করে — নাম সব জায়গাতেই লেখা থাকবে।
          </p>
        </div>

        <Field label="খোঁজার শব্দ" htmlFor="tag-aliases">
          <Input
            id="tag-aliases"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="যেমন: poribar, family, আম্মুর বাসা"
          />
        </Field>
        <p className="text-ink-muted -mt-2 text-xs">
          এই শব্দগুলো দিয়েও ট্যাগটি খুঁজে পাওয়া যাবে। ইংরেজিতে লিখে খুঁজতে চাইলে বানানটি এখানে
          রাখুন। কমা দিয়ে আলাদা করুন।
        </p>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending}>
          {save.isPending ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ করুন'}
        </Button>

        {/* Last, below a rule, and only on a tag that already exists.
         *
         * The list row used to carry a bin beside the name. Deleting a tag is
         * not destructive — the API detaches it and touches no transaction —
         * but nobody believes that at the moment their thumb is over the icon,
         * and the count that makes it believable is in the sheet that opens
         * after this button, not on the row. So the row is for looking and this
         * is where the decision gets made. */}
        {editing && onDelete ? (
          <div className="border-rule flex flex-col gap-2 border-t pt-4">
            <p className="text-ink-muted text-xs">
              {t(
                'tags.deleteHint',
                'ট্যাগটি লেনদেনগুলো থেকে সরে যাবে — একটি লেনদেনও মুছবে না। কতগুলোতে আছে তা পরের ধাপে লেখা থাকবে।',
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="block"
              className="text-expense"
              onClick={() => onDelete(editing)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t('tags.delete', 'ট্যাগটি সরিয়ে ফেলুন')}
            </Button>
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
