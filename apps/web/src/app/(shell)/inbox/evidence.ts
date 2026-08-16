/**
 * Putting the parser's evidence back where it came from.
 *
 * The API hands us `evidence: { field → the exact substring it was read from }`
 * but not the offsets, so the substrings have to be found again in the body.
 * That is the whole job of this file, and it is worth doing carefully: a
 * highlight over the wrong words is worse than no highlight at all, because it
 * tells the person checking the draft that the parser read something it did
 * not.
 *
 * Two rules keep it honest:
 *
 *  - **Longest span first.** In "BDT 12,500.00 credited", the amount evidence
 *    is `BDT 12,500.00`; if a shorter span were placed first it could take
 *    characters the longer one needs and push the amount into "not found".
 *  - **A span that cannot be placed is reported, never guessed.** It goes in
 *    `unlocated` and the screen lists it under the message as a quotation
 *    rather than drawing a box around whatever happens to be nearby.
 *
 * Matching is plain `indexOf` on the raw body. The parser slices its evidence
 * out of that exact string (see `packages/core/src/ingestion.ts`), so a
 * verbatim match is the correct test — no normalising, no case folding, and
 * emphatically no regex built from user text.
 */

/** The fields the server can quote. Order breaks ties between equal-length spans. */
export const EVIDENCE_FIELDS = [
  /* First, and ahead of `amountMinor`, because it is the longer span of the two
     and covers it: the quotation for a dollar charge is `USD 4.6`, not `4.6`.
     A draft never carries both — the server moves the quotation from one to the
     other when the message turns out to name a foreign currency — but the order
     is what stops a future one from being highlighted half-way. */
  'fxAmountMinor',
  'amountMinor',
  'direction',
  'date',
  'balanceMinor',
  'payee',
  'accountHint',
] as const;

export type MessageSegment =
  { kind: 'text'; text: string } | { kind: 'evidence'; field: string; text: string };

export interface LocatedEvidence {
  /** The whole body, in order, split into plain runs and quoted runs. */
  segments: MessageSegment[];
  /** Quotations that are not in the body verbatim. Shown, but not highlighted. */
  unlocated: { field: string; text: string }[];
}

interface Claim {
  field: string;
  start: number;
  end: number;
}

function fieldRank(field: string): number {
  const at = (EVIDENCE_FIELDS as readonly string[]).indexOf(field);
  return at === -1 ? EVIDENCE_FIELDS.length : at;
}

/**
 * Split `body` into highlighted and plain runs.
 *
 * Returns the body as a single plain segment when there is no evidence at all,
 * which is exactly what a zero-confidence draft looks like.
 */
export function locateEvidence(
  body: string,
  evidence: Record<string, string> | null | undefined,
): LocatedEvidence {
  const entries = Object.entries(evidence ?? {})
    .filter(([, text]) => typeof text === 'string' && text.length > 0)
    .sort(
      ([aField, aText], [bField, bText]) =>
        bText.length - aText.length || fieldRank(aField) - fieldRank(bField),
    );

  const claims: Claim[] = [];
  const unlocated: { field: string; text: string }[] = [];

  for (const [field, text] of entries) {
    let from = 0;
    let placed = false;

    for (;;) {
      const at = body.indexOf(text, from);
      if (at === -1) break;
      const end = at + text.length;
      /* The first already-placed span this occurrence runs into. Restarting
       * the search past it, rather than one character on, keeps this linear
       * and cannot loop: `blocker.end` is always greater than `from`. */
      const blocker = claims.find((claim) => at < claim.end && end > claim.start);
      if (!blocker) {
        claims.push({ field, start: at, end });
        placed = true;
        break;
      }
      from = blocker.end;
    }

    if (!placed) unlocated.push({ field, text });
  }

  claims.sort((a, b) => a.start - b.start);

  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const claim of claims) {
    if (claim.start > cursor) {
      segments.push({ kind: 'text', text: body.slice(cursor, claim.start) });
    }
    segments.push({
      kind: 'evidence',
      field: claim.field,
      text: body.slice(claim.start, claim.end),
    });
    cursor = claim.end;
  }
  if (cursor < body.length) segments.push({ kind: 'text', text: body.slice(cursor) });

  return { segments, unlocated };
}

/**
 * Did the parser *read* this field, or work it out?
 *
 * `read` — quoted from the message, and the quotation is shown.
 * `guessed` — the draft carries a value the message never stated.
 * `missing` — the draft has nothing for this field.
 */
export type FieldOrigin = 'read' | 'guessed' | 'missing';

export function originOf(
  value: unknown,
  field: string,
  evidence: Record<string, string> | null | undefined,
): FieldOrigin {
  const quoted = evidence?.[field];
  if (typeof quoted === 'string' && quoted.length > 0) return 'read';
  return value === null || value === undefined || value === '' ? 'missing' : 'guessed';
}
