import type { Metadata } from 'next';
import { StatementDocument, type PublicStatement } from './document';

/**
 * A statement, opened by somebody who has no account here.
 *
 * Server-rendered on purpose. The reader is a creditor or an insurer opening a
 * link on whatever phone they have; making them download and boot a React app
 * to see a page of figures they will probably print is the wrong trade. This
 * arrives as HTML, prints correctly with no JavaScript at all, and carries no
 * client bundle beyond what the shell already loads.
 */

export const dynamic = 'force-dynamic';

/**
 * Never indexed.
 *
 * The API sends `X-Robots-Tag` as well — this is the half a crawler reads when
 * it has the HTML rather than the header, and a link pasted into a public group
 * must not end up in a search result either way.
 */
export const metadata: Metadata = {
  title: 'বিবরণী — Taka Tracker',
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The same address the API proxy and the pricing page use, spelled the same
 * way: `API_INTERNAL_URL` is the server's origin *without* `/v1`, and the
 * default is 4000. Inventing a second convention here is what made this page
 * answer "the link no longer works" for a link that worked perfectly — the
 * fetch was going nowhere and the failure looked exactly like a revoked token.
 */
const API_ORIGIN = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

export default async function SharedStatementPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const response = await fetch(`${API_ORIGIN}/v1/public/statement/${encodeURIComponent(token)}`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    /* One message for every reason — unknown, revoked, expired. Telling a
       stranger which would confirm that somebody's statement was shared. */
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="text-ink text-xl font-semibold">লিংকটি আর কাজ করছে না</h1>
        <p className="text-ink-muted text-sm">
          যিনি পাঠিয়েছেন তাঁর কাছে নতুন একটি লিংক চেয়ে নিন।
        </p>
      </main>
    );
  }

  const statement = (await response.json()) as PublicStatement;
  return <StatementDocument statement={statement} />;
}
