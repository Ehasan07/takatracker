'use client';

/**
 * The signed-in device list.
 *
 * Self-contained: it owns its query, its mutations and its confirmation sheet,
 * so it drops into the settings page — or anywhere else — as `<SessionsList />`
 * and needs nothing around it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, RotateCw, Smartphone, Tablet, TriangleAlert } from '@/components/icons';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { t } from '@/lib/t';
import { api, ApiError } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { SkeletonRows } from './skeleton';
import { Button } from './ui/button';
import { Sheet } from './ui/sheet';

const bn = (value: number | string): string => fmtNumber(String(value));

interface Session {
  familyId: string;
  device: string;
  browser: string;
  kind: 'phone' | 'tablet' | 'desktop';
  lastUsedAt: string | null;
  createdAt: string | null;
  current: boolean;
}

/* -------------------------------------------------------------------------
 * Reading the payload
 * ---------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function pick(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** What the user calls the machine, from the only clue we have. */
function describeDevice(userAgent: string): { device: string; kind: Session['kind'] } {
  if (/iPad/i.test(userAgent)) return { device: t('device.ipad', 'আইপ্যাড'), kind: 'tablet' };
  if (/iPhone/i.test(userAgent)) return { device: t('device.iphone', 'আইফোন'), kind: 'phone' };
  if (/Android/i.test(userAgent)) {
    return /Mobile/i.test(userAgent)
      ? { device: t('device.androidPhone', 'অ্যান্ড্রয়েড ফোন'), kind: 'phone' }
      : { device: t('device.androidTablet', 'অ্যান্ড্রয়েড ট্যাব'), kind: 'tablet' };
  }
  if (/Windows/i.test(userAgent))
    return { device: t('device.windows', 'উইন্ডোজ কম্পিউটার'), kind: 'desktop' };
  if (/Macintosh|Mac OS/i.test(userAgent))
    return { device: t('device.mac', 'ম্যাক'), kind: 'desktop' };
  if (/CrOS/i.test(userAgent))
    return { device: t('device.chromebook', 'ক্রোমবুক'), kind: 'desktop' };
  if (/Linux/i.test(userAgent))
    return { device: t('device.linux', 'লিনাক্স কম্পিউটার'), kind: 'desktop' };
  return { device: t('device.unknown', 'অজানা ডিভাইস'), kind: 'desktop' };
}

function describeBrowser(userAgent: string): string {
  if (/Edg\//i.test(userAgent)) return t('browser.edge', 'এজ');
  if (/SamsungBrowser/i.test(userAgent)) return t('browser.samsung', 'স্যামসাং ইন্টারনেট');
  if (/OPR\/|Opera/i.test(userAgent)) return t('browser.opera', 'অপেরা');
  if (/Firefox\//i.test(userAgent)) return t('browser.firefox', 'ফায়ারফক্স');
  if (/Chrome\//i.test(userAgent)) return t('browser.chrome', 'ক্রোম');
  if (/Safari\//i.test(userAgent)) return t('browser.safari', 'সাফারি');
  return t('browser.unknown', 'অজানা ব্রাউজার');
}

function readSessions(payload: unknown): Session[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.items)
      ? payload.items
      : isRecord(payload) && Array.isArray(payload.sessions)
        ? payload.sessions
        : [];

  return list.map((entry, i) => {
    const row = isRecord(entry) ? entry : {};
    const userAgent = text(pick(row, ['userAgent', 'ua', 'agent']));
    // Never `deviceId`: that is an opaque handle, and showing it would put a
    // random identifier where the user expects to read "আইফোন".
    const explicitDevice = text(pick(row, ['device', 'deviceName']));
    const guessed = describeDevice(userAgent);
    const flag = pick(row, ['current', 'isCurrent', 'isCurrentSession', 'thisDevice']);

    return {
      familyId: text(pick(row, ['familyId', 'id', 'family'])) || String(i),
      device: explicitDevice || guessed.device,
      browser: text(pick(row, ['browser'])) || describeBrowser(userAgent),
      kind: guessed.kind,
      lastUsedAt: text(pick(row, ['lastUsedAt', 'usedAt', 'lastSeenAt', 'updatedAt'])) || null,
      createdAt: text(pick(row, ['createdAt', 'startedAt'])) || null,
      current: flag === true,
    };
  });
}

/** "৫ মিনিট আগে" — a timestamp nobody has to decode. */
function whenBn(value: string | null): string {
  if (!value) return t('session.whenUnknown', 'কখন জানা নেই');
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return t('session.whenUnknown', 'কখন জানা নেই');

  const minutes = Math.trunc((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return t('session.justNow', 'এইমাত্র');
  if (minutes < 60) return `${bn(minutes)} মিনিট আগে`;
  const hours = Math.trunc(minutes / 60);
  if (hours < 24) return `${bn(hours)} ঘণ্টা আগে`;
  const days = Math.trunc(hours / 24);
  if (days < 30) return `${bn(days)} দিন আগে`;

  return bn(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(at),
  );
}

/* -------------------------------------------------------------------------
 * The component
 * ---------------------------------------------------------------------- */

type Pending = { kind: 'one'; session: Session } | { kind: 'others' } | null;

export function SessionsList() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = React.useState<Pending>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [signedOut, setSignedOut] = React.useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    // Nothing left to fetch once this browser's own session is gone.
    enabled: signedOut === null,
    queryFn: async () => readSessions(await api<unknown>('/auth/sessions')),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  };

  /**
   * This browser is no longer signed in. Say so in words first — a silent jump
   * to the login screen reads as a bug — then take them there.
   */
  const signOut = (message: string): void => {
    setSignedOut(message);
    queryClient.clear();
  };

  React.useEffect(() => {
    if (signedOut === null) return;
    const timer = setTimeout(() => {
      router.push('/login');
      router.refresh();
    }, 4000);
    return () => clearTimeout(timer);
  }, [signedOut, router]);

  const revokeOne = useMutation({
    mutationFn: (session: Session) =>
      api<{ familyId: string; revoked: number; wasCurrent: boolean }>(
        `/auth/sessions/${encodeURIComponent(session.familyId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (result, session) => {
      haptic('success');
      setError(null);
      setPending(null);
      // The API decides whether that was us — it matched the refresh cookie,
      // which is the only thing that actually knows. Our `current` flag came
      // from a list that may be a minute old.
      if (result?.wasCurrent) {
        signOut(t('session.endedThis', 'এই ডিভাইসের সেশনটি বন্ধ করা হয়েছে। আবার লগইন করুন।'));
        return;
      }
      setNotice(`${session.device} থেকে বের করে দেওয়া হয়েছে।`);
      invalidate();
    },
    onError: (err) => {
      haptic('warn');
      setNotice(null);
      setPending(null);
      setError(err instanceof ApiError ? err.message : t('session.endFailed', 'বের করা যায়নি'));
    },
  });

  const revokeOthers = useMutation({
    mutationFn: () =>
      api<{ revoked: number; currentSessionRevoked: boolean; message?: string }>(
        '/auth/sessions/revoke-others',
        { method: 'POST', body: {} },
      ),
    onSuccess: (result) => {
      haptic('success');
      setError(null);
      setPending(null);
      // When the API could not tell which session was ours it revokes
      // everything, this browser included. Waiting for the next request to 401
      // would leave the user reading a screen that is quietly already dead.
      if (result?.currentSessionRevoked) {
        signOut(
          result.message ??
            'বর্তমান সেশনটি শনাক্ত করা যায়নি, তাই নিরাপত্তার জন্য সব ডিভাইস থেকে লগআউট করা হয়েছে। আবার লগইন করুন।',
        );
        return;
      }
      setNotice(
        result?.message ??
          t('session.endedOthers', 'এই ডিভাইস ছাড়া বাকি সব জায়গা থেকে লগআউট করা হয়েছে।'),
      );
      invalidate();
    },
    onError: (err) => {
      haptic('warn');
      setNotice(null);
      setPending(null);
      setError(
        err instanceof ApiError ? err.message : t('session.signOutFailed', 'লগআউট করা যায়নি'),
      );
    },
  });

  const rows = sessions.data ?? [];
  const others = rows.filter((row) => !row.current).length;
  const busy = revokeOne.isPending || revokeOthers.isPending;

  if (signedOut !== null) {
    return (
      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">
          {t('session.title', 'যেসব ডিভাইসে লগইন আছে')}
        </h2>
        <p role="status" className="text-ink mt-2 flex items-start gap-2 text-sm">
          <LogOut className="text-brass mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{signedOut}</span>
        </p>
        <p className="text-ink-muted mt-1 text-xs">
          {t('session.redirecting', 'লগইন পাতায় নিয়ে যাচ্ছি…')}
        </p>
        <Button
          className="mt-3"
          onClick={() => {
            router.push('/login');
            router.refresh();
          }}
        >
          এখনই লগইন করুন
        </Button>
      </section>
    );
  }

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-ink-muted text-sm font-medium">
          {t('session.title', 'যেসব ডিভাইসে লগইন আছে')}
        </h2>
        {rows.length > 0 ? (
          <span className="text-ink-muted text-xs">{bn(rows.length)}টি</span>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="bg-income/10 text-income mt-2 rounded-md px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="bg-expense/10 text-expense mt-2 rounded-md px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {sessions.isError ? (
        <div
          role="alert"
          className="border-rule mt-3 flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center"
        >
          <TriangleAlert className="text-expense h-6 w-6" aria-hidden />
          <p className="text-ink text-sm">
            {t('session.listFailed', 'ডিভাইসের তালিকা আনা যায়নি।')}
          </p>
          <Button variant="outline" size="sm" onClick={() => void sessions.refetch()}>
            <RotateCw className="h-4 w-4" aria-hidden />
            আবার চেষ্টা করুন
          </Button>
        </div>
      ) : sessions.isLoading ? (
        <div className="border-rule mt-3 overflow-hidden rounded-md border">
          <SkeletonRows rows={3} />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-ink-muted mt-3 text-sm">
          {t('session.none', 'কোনো সক্রিয় সেশন পাওয়া যায়নি।')}
        </p>
      ) : (
        <ul className="divide-rule mt-2 divide-y">
          {rows.map((session) => (
            <li key={session.familyId} className="flex items-center gap-3 py-3">
              <DeviceIcon kind={session.kind} />
              <div className="min-w-0 flex-1">
                <p className="text-ink flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{session.device}</span>
                  {session.current ? (
                    <span className="bg-income/10 text-income shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
                      এই ডিভাইস
                    </span>
                  ) : null}
                </p>
                <p className="text-ink-muted truncate text-xs">
                  {session.browser} · সর্বশেষ {whenBn(session.lastUsedAt)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  haptic('tap');
                  setPending({ kind: 'one', session });
                }}
              >
                বের করুন
              </Button>
            </li>
          ))}
        </ul>
      )}

      {others > 0 ? (
        <Button
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={() => {
            haptic('tap');
            setPending({ kind: 'others' });
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          অন্য সব ডিভাইস থেকে বের করুন
        </Button>
      ) : null}

      <Sheet
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending?.kind === 'others'
            ? t('session.confirmAll', 'অন্য সব ডিভাইস থেকে বের করবেন?')
            : t('session.confirmOne', 'এই সেশনটি বন্ধ করবেন?')
        }
        description={pending?.kind === 'one' ? pending.session.device : undefined}
      >
        <div className="flex flex-col gap-4">
          {pending?.kind === 'others' ? (
            <p className="text-ink text-sm">
              এই ডিভাইস ছাড়া বাকি {bn(others)}টি জায়গা থেকে লগআউট হয়ে যাবে। ওই ডিভাইসগুলোতে আবার
              পাসওয়ার্ড দিয়ে ঢুকতে হবে।
            </p>
          ) : pending?.kind === 'one' && pending.session.current ? (
            <p className="text-ink text-sm">
              এটি আপনি এখন যে ডিভাইসে আছেন সেটিই। বন্ধ করলে সঙ্গে সঙ্গে লগআউট হয়ে যাবেন।
            </p>
          ) : (
            <p className="text-ink text-sm">
              {pending?.kind === 'one'
                ? pending.session.device
                : t('session.theDevice', 'ডিভাইসটি')}{' '}
              থেকে লগআউট হয়ে যাবে। ওখানে আবার পাসওয়ার্ড দিয়ে ঢুকতে হবে।
            </p>
          )}

          <Button
            variant="danger"
            size="block"
            disabled={busy}
            onClick={() => {
              haptic('warn');
              if (pending?.kind === 'others') revokeOthers.mutate();
              else if (pending?.kind === 'one') revokeOne.mutate(pending.session);
            }}
          >
            {pending?.kind === 'others'
              ? t('session.yesAll', 'হ্যাঁ, সব বন্ধ করুন')
              : t('session.yesOne', 'হ্যাঁ, বন্ধ করুন')}
          </Button>
          <Button variant="outline" size="block" onClick={() => setPending(null)}>
            থাক
          </Button>
        </div>
      </Sheet>
    </section>
  );
}

function DeviceIcon({ kind }: { kind: Session['kind'] }) {
  const className = 'text-ink-muted h-5 w-5 shrink-0';
  if (kind === 'phone') return <Smartphone className={className} aria-hidden />;
  if (kind === 'tablet') return <Tablet className={className} aria-hidden />;
  return <Monitor className={className} aria-hidden />;
}
