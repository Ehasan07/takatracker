'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, endpoints } from '@/lib/api';
import { t } from '@/lib/t';
import { resetSessionForSignOut } from '@/lib/session-reset';
import { UsageMeter } from '@/components/usage-meter';
import { AiSettings } from '@/components/ai-settings';
import { BusinessSettings } from '@/components/business-settings';
import { CloseAccount } from '@/components/close-account';
import { SessionsList } from '@/components/sessions-list';
import { IngestionSettings } from '@/components/ingestion-settings';
import { MailSettings } from '@/components/mail-settings';
import { TelegramSettings } from '@/components/telegram-settings';
import { LanguageSettings } from '@/components/language-settings';
import { UnitSettings } from '@/components/unit-settings';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { AppearanceSettings } from './appearance';

export default function SettingsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: endpoints.me });
  const entitlements = useQuery({ queryKey: ['entitlements'], queryFn: endpoints.entitlements });

  const logout = async (): Promise<void> => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    /* After the token is dead so a racing tab cannot refill the cache, and
     * before navigating so nothing survives into /login. Without this the
     * service worker keeps serving the previous person's balances offline on a
     * shared phone. */
    await resetSessionForSignOut(queryClient);
    router.push('/login');
    router.refresh();
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
        {t('nav.settings', 'সেটিংস')}
      </h1>

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">{t('shell.account', 'অ্যাকাউন্ট')}</h2>
        <p className="text-ink mt-1">{me.data?.name}</p>
        <p className="text-ink-muted text-sm">{me.data?.email}</p>
      </section>

      {/* Above the plan, because somebody who cannot find a feature will not go
          looking for the manual below their billing. */}
      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">
          {t('settings.guide', 'কী কী করা যায়')}
        </h2>
        <p className="text-ink-muted mt-1 text-sm">
          {t('settings.guide.blurb', 'অ্যাপের প্রতিটি জিনিস কোথায় আর কীভাবে কাজ করে')}
        </p>
        <Link
          href="/help"
          className="press border-rule text-ink mt-3 inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
        >
          {t('settings.guide.open', 'তালিকা দেখুন')}
        </Link>
      </section>

      {/* Directly under the manual, because the two answer the same person: one
          has found what they were looking for, the other has not. Above the
          plan for the same reason the manual is — somebody who cannot make the
          app do something will not scroll past their billing to say so. */}
      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">{t('feedback.title', 'মতামত পাঠান')}</h2>
        <p className="text-ink-muted mt-1 text-sm">
          {t('feedback.settingsBlurb', 'কী ভুল হচ্ছে, আর কী থাকলে ভালো হতো — লিখে পাঠান')}
        </p>
        <Link
          href="/feedback?from=/settings"
          className="press border-rule text-ink mt-3 inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
        >
          {t('feedback.open', 'মতামত লিখুন')}
        </Link>
      </section>

      <section className="rounded-card border-rule bg-surface border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-ink-muted text-sm font-medium">{t('settings.plan', 'প্ল্যান')}</h2>
          <span className="text-ink text-sm font-semibold">
            {entitlements.data?.plan?.name ?? '—'}
          </span>
        </div>
        {entitlements.data?.plan && entitlements.data.plan.priceMinor > 0 ? (
          <p className="text-ink-muted mt-1 text-xs">
            <Money minor={entitlements.data.plan.priceMinor} className="inline" decimals={false} />{' '}
            / {t('settings.perMonth', 'মাস')}
          </p>
        ) : null}

        <div className="mt-3 flex flex-col gap-3">
          <UsageMeter
            label={t('entry.account', 'অ্যাকাউন্ট')}
            used={entitlements.data?.usage['accounts.max'] ?? 0}
            limit={entitlements.data?.entitlements['accounts.max'] ?? null}
          />
          <UsageMeter
            label={t('settings.monthlyEntries', 'এই মাসের লেনদেন')}
            used={entitlements.data?.usage['transactions.monthly.max'] ?? 0}
            limit={entitlements.data?.entitlements['transactions.monthly.max'] ?? null}
          />
          <UsageMeter
            label={t('settings.members', 'সদস্য')}
            used={entitlements.data?.usage['members.max'] ?? 0}
            limit={entitlements.data?.entitlements['members.max'] ?? null}
          />
        </div>
      </section>

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">
          {t('settings.categories', 'খাত ব্যবস্থাপনা')}
        </h2>
        <p className="text-ink-muted mt-1 text-sm">
          {t('nav.categories.blurb', 'আয় ও খরচের খাত যোগ করুন, নাম বদলান, মুছুন')}
        </p>
        <Link
          href="/categories"
          className="press bg-income mt-3 inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-white"
        >
          {t('settings.seeCategories', 'ক্যাটাগরি দেখুন')}
        </Link>
      </section>

      {/* Its own screen rather than a section here, because it is the only thing
          in settings that produces a figure somebody might act on — and a figure
          needs the room to show its working and carry its disclaimer beside it,
          which a card between the theme picker and the language picker does
          not have. */}
      <section className="rounded-card border-rule bg-surface border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-ink-muted text-sm font-medium">{t('settings.tax', 'আয়কর')}</h2>
          <span className="border-brass text-brass rounded-md border px-2 py-0.5 text-xs font-semibold">
            {t('settings.tax.beta', 'বেটা')}
          </span>
        </div>
        <p className="text-ink-muted mt-1 text-sm">
          {t(
            'settings.tax.blurb',
            'জুলাই–জুন অর্থবছরের আয়, বিনিয়োগ ও সম্পদের একটি খসড়া হিসাব। রিটার্ন নয়।',
          )}
        </p>
        <Link
          href="/settings/tax"
          className="press border-rule text-ink mt-3 inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium"
        >
          {t('settings.tax.open', 'আয়কর হিসাব দেখুন')}
        </Link>
      </section>

      <LanguageSettings />

      <UnitSettings />

      <TelegramSettings />

      <IngestionSettings />

      <BusinessSettings />

      <AiSettings />

      <MailSettings />

      <SessionsList />

      <AppearanceSettings />

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">{t('settings.nextUp', 'পরের ধাপ')}</h2>
        <ul className="text-ink-muted mt-2 list-disc pl-5 text-sm">
          <li>
            {t(
              'settings.next.sms',
              'ব্যাংকের এসএমএস পড়ে খসড়া তৈরি — আপনার আসল বার্তার নমুনা পেলে',
            )}
          </li>
          <li>{t('settings.next.email', 'ইমেইলে যাচাই ও পাসওয়ার্ড রিসেটের লিংক পাঠানো')}</li>
          <li>{t('settings.next.mobile', 'মোবাইল অ্যাপ')}</li>
        </ul>
      </section>

      <CloseAccount />

      <Button variant="outline" onClick={() => void logout()}>
        লগআউট
      </Button>
    </div>
  );
}
