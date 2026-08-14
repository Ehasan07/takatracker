/**
 * The shapes `apps/api/src/people` returns, and the small rules the person
 * screens share.
 *
 * **Why this screen exists.** A `Person` used to be a side effect: recording a
 * loan created one from whatever name was typed, and nothing in the product
 * could ever edit it again. A phone entered wrong was permanent, `সম্পর্ক` and
 * the note were columns nothing wrote, and the party ledger — the one page a
 * counterparty's whole history lives on — could not rename the person it is
 * about. Two করিমs, created by typing the name twice, split that ledger in half
 * with no sign on either half that the other exists.
 *
 * Amounts are integer poisha exactly as the API sends them; nothing here turns
 * one into taka except `<Money>`.
 */

/** `GET /v1/people?q=` — one row per contact, with what stands between you. */
export interface PersonDto {
  id: string;
  /** P-0001 — the handle you can read down a phone. Unique per workspace. */
  code: string;
  name: string;
  /** Canonical `01XXXXXXXXX` when the API recognised it as a BD mobile. */
  phone: string | null;
  relation: string | null;
  note: string | null;
  photoUri: string | null;
  /** Live, non-cancelled loans — the same set the party ledger totals. */
  loanCount: number;
  /** Still owed to you, interest included. */
  receivableMinor: number;
  /** Still owed by you, interest included. */
  payableMinor: number;
  /** `receivable − payable`. Positive means they owe you. */
  netMinor: number;
  transactionCount: number;
  /** `YYYY-MM-DD` in the workspace calendar, or null if nothing ever happened. */
  lastActivityDate: string | null;
  createdAt: string;
  /** Others in this workspace that look like the same human. A hint, not a verdict. */
  duplicateOfIds: string[];
  /** Only on a `?q=` response. `suggestion` means the matcher is guessing. */
  bucket?: 'main' | 'suggestion';
}

/** `DELETE /v1/people/:id` — states out loud that no transaction was destroyed. */
export interface DeletePersonResult {
  id: string;
  name: string;
  transactionCount: number;
  message: string;
}

/** Which blank columns on the survivor a merge filled in. */
export type PersonField = 'phone' | 'relation' | 'note' | 'photoUri';

/** `POST /v1/people/:id/merge` */
export interface MergePeopleResult {
  from: { id: string; name: string };
  into: { id: string; name: string };
  movedLoanCount: number;
  /** Instalments that travelled with their loans. Nothing was rewritten for them. */
  movedPaymentCount: number;
  movedTransactionCount: number;
  carriedOver: PersonField[];
  /**
   * Null when both rows already had the same name. Otherwise the name going
   * away and whether it survived as searchable text — `Person` has no alias
   * column, so the API keeps it in the note or not at all, and the screen must
   * not promise what `kept: false` says did not happen.
   */
  previousName: { value: string; kept: boolean } | null;
  message: string;
}

export const CARRIED_OVER_LABEL: Record<PersonField, string> = {
  phone: 'ফোন নম্বর',
  relation: 'সম্পর্ক',
  note: 'নোট',
  photoUri: 'ছবি',
};

/**
 * Common relations, offered as suggestions rather than as a fixed list.
 *
 * A `<datalist>`, so the field stays free text: Bengali kinship is far finer
 * than any dropdown — মামা, চাচা, খালু and ফুফা are four different people and
 * all of them are "uncle" — and a picker that cannot say the true one teaches
 * people to leave the field empty.
 */
export const RELATION_SUGGESTIONS: readonly string[] = [
  'পরিবার',
  'আত্মীয়',
  'বন্ধু',
  'প্রতিবেশী',
  'সহকর্মী',
  'ব্যবসায়িক',
  'দোকানদার',
  'বাড়িওয়ালা',
  'ভাড়াটিয়া',
];

export const bn = (value: number | string): string => fmtNumber(String(value));

/**
 * The API sends `YYYY-MM-DD`; anything else must not take the screen down.
 * Same guard as the loan screens use, for the same reason.
 */
/* One implementation, in `lib/format.ts`, which follows the workspace's
   language. There were ten near-identical copies of these across the app and
   every one of them hardcoded Bengali digits. The old names are re-exported so
   the call sites in this folder stay as they are. */
import { fmtDate as bnDate, fmtNumber } from '@/lib/format';

export { bnDate };

/**
 * The one or two letters that stand in for a face.
 *
 * `Intl.Segmenter` rather than `slice`, because a Bengali cluster is several
 * code points — কৃ is ক + ্ + ৃ — and cutting it at one would print a broken
 * glyph. Two clusters, so করিম উদ্দিন reads as কউ rather than as ক.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const picked = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return picked.map(firstCluster).join('') || '?';
}

function firstCluster(word: string): string {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('bn', { granularity: 'grapheme' });
    for (const segment of segmenter.segment(word)) return segment.segment;
    return '';
  }
  return [...word][0] ?? '';
}

/**
 * A photo reference safe to hand to `<img src>` — which, here, means one served
 * from our own origin.
 *
 * `next.config.ts` sets `img-src 'self' data: blob:`, so a remote `https://`
 * photo the API happily stores would be blocked by the browser and render as a
 * broken image. Rather than show one, anything that is not a same-origin path
 * falls back to initials. There is no uploader yet; when one lands it will
 * produce exactly the `/…` form this accepts.
 */
export function safePhotoUri(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\/[^/\\]/.test(trimmed) ? trimmed : null;
}

/**
 * How a person's position reads in one line.
 *
 * Two figures rather than one total, because somebody can both owe you and be
 * owed by you, and adding those together produces a number that means nothing.
 * The net is what the party ledger prints, so it is what this agrees with.
 */
export function positionLabel(person: PersonDto): string {
  if (person.netMinor > 0) return 'পাব';
  if (person.netMinor < 0) return 'দেব';
  return person.loanCount > 0 ? 'হিসাব সমান' : '';
}
