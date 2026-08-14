'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/lib/t';
import { GUIDE } from '@/content/guide';

/**
 * The manual, rendered.
 *
 * Everything it says lives in `content.ts`; this file is the shape it takes on
 * screen. It sits inside the shell rather than on the marketing site because it
 * describes the app somebody is signed in to, including the parts a visitor
 * cannot see.
 */
export default function GuidePage() {
  return (
    <div data-testid="guide" className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Link
        href="/settings"
        className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('nav.settings', 'সেটিংস')}
      </Link>

      <header>
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">
          {t('guide.title', 'কী কী করা যায়')}
        </h1>
        <p className="text-ink-muted mt-1 text-sm">
          {t(
            'guide.blurb',
            'এই অ্যাপে এখন যা যা আছে, কোথায় আছে, আর কোন জিনিসটা মানুষ সবচেয়ে বেশি ভুল বোঝে।',
          )}
        </p>
      </header>

      {GUIDE.map((group) => (
        <section key={group.key} className="rounded-card border-rule bg-surface border p-4">
          <h2 className="text-ink text-base font-semibold">{t(`${group.key}.h`, group.heading)}</h2>
          {group.blurb ? (
            <p className="text-ink-muted text-xs">{t(`${group.key}.s`, group.blurb)}</p>
          ) : null}

          <ul className="divide-rule mt-3 divide-y">
            {group.entries.map((entry) => (
              <li key={entry.key} className="py-3 first:pt-0 last:pb-0">
                <p className="text-ink text-sm font-medium">{t(`${entry.key}.t`, entry.title)}</p>
                <p className="text-ink-muted text-xs">{t(`${entry.key}.w`, entry.where)}</p>
                <p className="text-ink-muted mt-1 text-sm">{t(`${entry.key}.b`, entry.body)}</p>
                {entry.note ? (
                  /* The half a generated list could never carry: the thing
                     somebody gets wrong when nobody tells them. */
                  <p className="text-ink-muted border-brand/40 mt-1.5 border-l-2 pl-2 text-xs">
                    {t(`${entry.key}.n`, entry.note)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="text-ink-muted pb-4 text-xs">
        {t(
          'guide.footer',
          'এখানে যা লেখা আছে সেটা যদি পর্দায় খুঁজে না পান, ধরে নিন ভুলটা আমাদের — জানাবেন।',
        )}
      </p>
    </div>
  );
}
