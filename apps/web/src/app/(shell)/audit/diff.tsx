'use client';

import { ArrowRight, Minus, Plus } from 'lucide-react';
import * as React from 'react';
import { Money } from '@/components/money';
import { cn } from '@/lib/utils';
import {
  bnBytes,
  bnDateish,
  bnNum,
  bpsToPercent,
  DATE_FIELDS,
  enumLabel,
  fieldLabel,
  ID_FIELDS,
  legDirectionLabel,
  shortId,
} from './labels';
import {
  diffLegs,
  minorOf,
  readLegs,
  sameValue,
  type AuditEvent,
  type JsonObject,
  type JsonValue,
  type Leg,
} from './types';

/**
 * Turning a foreign key into the name the user gave the thing. The audit row
 * only stores ids, so "খাত: বাজার → জ্বালানি" needs the account and category
 * lists alongside it. When a lookup fails — the category was deleted after the
 * event, say — the tail of the id is shown rather than a wrong name.
 */
export interface NameResolver {
  account: (id: string) => string | undefined;
  category: (id: string) => string | undefined;
}

/* -------------------------------------------------------------------------
 * One value
 * ---------------------------------------------------------------------- */

function Blank({ text = '—' }: { text?: string }) {
  return <span className="text-ink-muted">{text}</span>;
}

function resolveId(fieldKey: string, id: string, resolve: NameResolver): string {
  if (fieldKey === 'accountId' || fieldKey === 'counterAccountId' || fieldKey === 'loanAccountId') {
    return resolve.account(id) ?? shortId(id);
  }
  if (fieldKey === 'categoryId') return resolve.category(id) ?? shortId(id);
  return shortId(id);
}

/**
 * A single value from `before` or `after`, rendered as the thing it is.
 *
 * Money is the reason this exists: `amountMinor: 500000` is integer poisha and
 * has to reach the screen as ৳৫,০০০.০০ through `<Money>`, never as the number
 * that was stored.
 */
export function Value({
  fieldKey,
  value,
  resolve,
}: {
  fieldKey: string;
  value: JsonValue | undefined;
  resolve: NameResolver;
}) {
  if (value === undefined || value === null) {
    return <Blank text={fieldKey === 'categoryId' ? 'খাত ছাড়া' : '—'} />;
  }

  if (typeof value === 'boolean') return <>{value ? 'হ্যাঁ' : 'না'}</>;

  if (typeof value === 'number') {
    if (fieldKey.endsWith('Minor')) {
      const minor = minorOf(value);
      // A non-integer would make `formatMinor` throw mid-render. Show the raw
      // number instead of taking the log down with it.
      return minor === null ? <>{bnNum(value)}</> : <Money minor={minor} className="inline" />;
    }
    if (fieldKey === 'interestRateBps') return <>{bpsToPercent(Math.trunc(value))}</>;
    if (fieldKey === 'sizeBytes') return <>{bnBytes(value)}</>;
    if (fieldKey === 'confidence' && value >= 0 && value <= 1) {
      return <>{bnNum(Math.trunc(value * 100))}%</>;
    }
    return <>{bnNum(value)}</>;
  }

  if (typeof value === 'string') {
    if (value === '') return <Blank text="ফাঁকা" />;
    if (DATE_FIELDS.has(fieldKey)) return <>{bnDateish(value)}</>;
    if (ID_FIELDS.has(fieldKey)) return <>{resolveId(fieldKey, value, resolve)}</>;
    return <>{enumLabel(fieldKey, value)}</>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <Blank text="কিছু নেই" />;
    if (fieldKey === 'attachmentIds') return <>{bnNum(value.length)}টি ফাইল</>;
    return (
      <>
        {value.map((item, i) => (
          <React.Fragment key={i}>
            {i > 0 ? ', ' : ''}
            <Value fieldKey={fieldKey} value={item} resolve={resolve} />
          </React.Fragment>
        ))}
      </>
    );
  }

  // A nested object: its own key/value lines, never a JSON blob on the screen.
  const keys = Object.keys(value);
  if (keys.length === 0) return <Blank text="কিছু নেই" />;
  return (
    <>
      {keys.map((key, i) => (
        <React.Fragment key={key}>
          {i > 0 ? ' · ' : ''}
          <span className="text-ink-muted">{fieldLabel(key)}: </span>
          <Value fieldKey={key} value={value[key]} resolve={resolve} />
        </React.Fragment>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------
 * One changed field
 * ---------------------------------------------------------------------- */

function ChangeRow({
  fieldKey,
  from,
  to,
  resolve,
}: {
  fieldKey: string;
  from: JsonValue | undefined;
  to: JsonValue | undefined;
  resolve: NameResolver;
}) {
  return (
    <div className="min-w-0">
      <p className="text-ink-muted text-[11px]">{fieldLabel(fieldKey)}</p>
      {/* Wraps rather than scrolls: at 320px a long name must fall to the next
          line, not push the page sideways. */}
      <p className="text-ink flex min-w-0 flex-wrap items-center gap-x-1.5 break-words text-sm">
        <span className="sr-only">আগে</span>
        <span className="text-ink-muted line-through">
          <Value fieldKey={fieldKey} value={from} resolve={resolve} />
        </span>
        <ArrowRight className="text-ink-muted h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="sr-only">এখন</span>
        <span className="font-medium">
          <Value fieldKey={fieldKey} value={to} resolve={resolve} />
        </span>
      </p>
    </div>
  );
}

function FactRow({
  fieldKey,
  value,
  resolve,
}: {
  fieldKey: string;
  value: JsonValue | undefined;
  resolve: NameResolver;
}) {
  return (
    <div className="min-w-0">
      <p className="text-ink-muted text-[11px]">{fieldLabel(fieldKey)}</p>
      <p className="text-ink min-w-0 break-words text-sm">
        <Value fieldKey={fieldKey} value={value} resolve={resolve} />
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The ledger legs
 * ---------------------------------------------------------------------- */

function LegSummary({ leg, resolve }: { leg: Leg; resolve: NameResolver }) {
  const account = leg.accountId ? (resolve.account(leg.accountId) ?? shortId(leg.accountId)) : null;
  const category = leg.categoryId
    ? (resolve.category(leg.categoryId) ?? shortId(leg.categoryId))
    : null;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      {leg.direction ? (
        <span className="text-ink-muted">{legDirectionLabel(leg.direction)}</span>
      ) : null}
      {account ? <span className="text-ink">{account}</span> : null}
      {category ? <span className="text-ink-muted">· {category}</span> : null}
      {leg.amountMinor === null ? null : <Money minor={leg.amountMinor} className="text-ink" />}
    </span>
  );
}

const LEG_FIELDS: readonly (keyof Leg)[] = ['accountId', 'categoryId', 'direction', 'amountMinor'];

function LegChange({ from, to, resolve }: { from: Leg; to: Leg; resolve: NameResolver }) {
  const moved = LEG_FIELDS.filter((key) => from[key] !== to[key]);
  const held = LEG_FIELDS.filter((key) => from[key] === to[key] && from[key] !== null);

  return (
    <div className="border-rule min-w-0 rounded-md border px-2 py-1.5">
      {held.length > 0 ? (
        <p className="text-ink-muted flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
          {held.map((key, i) => (
            <React.Fragment key={key}>
              {i > 0 ? <span aria-hidden>·</span> : null}
              <Value fieldKey={key} value={from[key]} resolve={resolve} />
            </React.Fragment>
          ))}
        </p>
      ) : null}
      <div className="mt-1 flex flex-col gap-1.5">
        {moved.map((key) => (
          <ChangeRow key={key} fieldKey={key} from={from[key]} to={to[key]} resolve={resolve} />
        ))}
      </div>
    </div>
  );
}

function LegLine({
  leg,
  tone,
  resolve,
}: {
  leg: Leg;
  tone: 'added' | 'removed';
  resolve: NameResolver;
}) {
  const Icon = tone === 'added' ? Plus : Minus;
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-xs">
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          tone === 'added' ? 'text-income' : 'text-expense',
        )}
        aria-hidden
      />
      <span className="sr-only">{tone === 'added' ? 'যোগ হয়েছে' : 'বাদ গেছে'}</span>
      <LegSummary leg={leg} resolve={resolve} />
    </p>
  );
}

function LegsBlock({
  before,
  after,
  resolve,
}: {
  before: JsonValue | undefined;
  after: JsonValue | undefined;
  resolve: NameResolver;
}) {
  const diff = diffLegs(readLegs(before), readLegs(after));
  const nothing = diff.changed.length === 0 && diff.removed.length === 0 && diff.added.length === 0;
  if (nothing) return null;

  return (
    <div className="min-w-0">
      <p className="text-ink-muted text-[11px]">{fieldLabel('entries')}</p>
      <div className="mt-1 flex flex-col gap-1.5">
        {diff.changed.map((pair, i) => (
          <LegChange key={`c${i}`} from={pair.from} to={pair.to} resolve={resolve} />
        ))}
        {diff.removed.map((leg, i) => (
          <LegLine key={`r${i}`} leg={leg} tone="removed" resolve={resolve} />
        ))}
        {diff.added.map((leg, i) => (
          <LegLine key={`a${i}`} leg={leg} tone="added" resolve={resolve} />
        ))}
        {diff.unchanged > 0 ? (
          <p className="text-ink-muted text-[11px]">
            আরও {bnNum(diff.unchanged)}টি লাইন অপরিবর্তিত
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LegsList({ legs, resolve }: { legs: Leg[]; resolve: NameResolver }) {
  if (legs.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="text-ink-muted text-[11px]">{fieldLabel('entries')}</p>
      <div className="mt-1 flex flex-col gap-1">
        {legs.map((leg, i) => (
          <p key={i} className="min-w-0 text-xs">
            <LegSummary leg={leg} resolve={resolve} />
          </p>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The block under a row
 * ---------------------------------------------------------------------- */

/** A payload that only says "this is gone" is a tombstone, not an edit. */
const isTombstone = (payload: JsonObject | null): boolean => payload?.deleted === true;

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-rule bg-greenbar/40 mt-3 min-w-0 rounded-md border border-dashed p-2.5">
      <p className="text-ink-muted text-[11px] font-medium">{title}</p>
      <div className="mt-1.5 flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
}

export function ChangeBlock({ event, resolve }: { event: AuditEvent; resolve: NameResolver }) {
  const before = event.before;
  const after = event.after;
  if (!before && !after) return null;

  // Both sides recorded, and the later one is a real snapshot: a true edit.
  if (before && after && !isTombstone(after)) {
    /* Only keys present in both. `account.updated` writes `type` into `before`
     * and leaves it out of `after`; treating that absence as "changed to
     * nothing" would invent an edit nobody made. */
    const shared = Object.keys(after).filter((key) => key in before);
    const changed = shared.filter((key) => !sameValue(before[key], after[key]));
    const scalars = changed.filter((key) => key !== 'entries');
    const legsChanged = changed.includes('entries');

    /* Written on the later side only — `savings.installment_paid` records the
     * status on both sides but the amount and the date on `after` alone. That
     * is not a change from anything; it is what else the event says, so it goes
     * in its own group rather than being drawn as "— → ৳২,০০০.০০". Keys on the
     * earlier side only are dropped: their absence later says nothing. */
    const alsoWritten = Object.keys(after).filter(
      (key) => !(key in before) && key !== 'entries' && after[key] !== null,
    );

    if (scalars.length === 0 && !legsChanged && alsoWritten.length === 0) {
      return (
        <Frame title="কী বদলেছে">
          <p className="text-ink-muted text-xs">
            যে ঘরগুলো এখানে রাখা হয়, সেগুলোর কোনোটাই বদলায়নি।
          </p>
        </Frame>
      );
    }

    return (
      <>
        {scalars.length > 0 || legsChanged ? (
          <Frame title="কী বদলেছে">
            {scalars.map((key) => (
              <ChangeRow
                key={key}
                fieldKey={key}
                from={before[key]}
                to={after[key]}
                resolve={resolve}
              />
            ))}
            {legsChanged ? (
              <LegsBlock before={before.entries} after={after.entries} resolve={resolve} />
            ) : null}
          </Frame>
        ) : null}
        {alsoWritten.length > 0 ? (
          <Frame title="সঙ্গে যা লেখা আছে">
            {alsoWritten.map((key) => (
              <FactRow key={key} fieldKey={key} value={after[key]} resolve={resolve} />
            ))}
          </Frame>
        ) : null}
      </>
    );
  }

  // Only the earlier state, or a tombstone: what the record used to say.
  if (before) {
    const extra = after
      ? Object.keys(after).filter((key) => key !== 'deleted' && after[key] !== null)
      : [];
    return (
      <Frame title="যা ছিল">
        {Object.keys(before)
          .filter((key) => key !== 'entries')
          .map((key) => (
            <FactRow key={key} fieldKey={key} value={before[key]} resolve={resolve} />
          ))}
        <LegsList legs={readLegs(before.entries)} resolve={resolve} />
        {extra.length > 0 ? (
          <div className="border-rule min-w-0 border-t pt-2">
            {extra.map((key) => (
              <FactRow key={key} fieldKey={key} value={after?.[key]} resolve={resolve} />
            ))}
          </div>
        ) : null}
      </Frame>
    );
  }

  // Only the later state: what was written down.
  const keys = Object.keys(after ?? {}).filter((key) => key !== 'entries');
  if (keys.length === 0 && readLegs(after?.entries).length === 0) return null;

  return (
    <Frame title="যা রেকর্ড হয়েছে">
      {keys.map((key) => (
        <FactRow key={key} fieldKey={key} value={after?.[key]} resolve={resolve} />
      ))}
      <LegsList legs={readLegs(after?.entries)} resolve={resolve} />
    </Frame>
  );
}
