import { MarketingFooter, MarketingHeader } from './marketing-chrome';

/**
 * The public site's shell.
 *
 * Deliberately not `AppShell`: that one is a fixed frame with its own scroll
 * container, which is right for an app and wrong for a page somebody arrives
 * at from a search result. Here the *document* scrolls, so a phone's address
 * bar collapses the way it does on every other website and `scroll-behavior:
 * smooth` can reach an anchor. `globals.css` locks body scrolling only when the
 * app shell is on the page.
 *
 * No providers, no query client, no data fetching on the client at all. Every
 * public page is server-rendered and static, because the two things that
 * decide whether a page ranks are whether the answer is in the HTML and how
 * fast that HTML arrives.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-paper text-ink flex min-h-dvh flex-col">
      {/* First tab stop on every public page. A landing page is a wall of
          links and a keyboard user should be able to step over it. */}
      <a
        href="#main"
        className="bg-income sr-only rounded-md px-4 text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center"
      >
        মূল অংশে যান
      </a>
      <MarketingHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <MarketingFooter />
    </div>
  );
}
