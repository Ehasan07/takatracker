import { NextResponse, type NextRequest } from 'next/server';

/**
 * Reachable without a session. `/verify`, `/forgot` and `/reset` have to be
 * here: they are opened from an email link, by definition on a device that is
 * not signed in. Bouncing them to /login would also drop the `?token=`, which
 * the redirect below does not carry — so the link would be spent for nothing
 * and the user would have to request another.
 */
const PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/offline',
  '/verify',
  '/forgot',
  '/reset',
  /* The marketing site. `/home` is the landing page's real route; `/` rewrites
   * to it below for anybody without a session, and both canonicalise to `/`. */
  '/home',
  '/pricing',
  '/guide',
  /* How to keep books, and how not to. Written for somebody deciding whether
     to open an account, so requiring one to read it would be backwards — and
     the rules on it are bookkeeping's rather than ours to gate. */
  '/tutorial',
  /* How to make bank SMS write your books, on Android and on iPhone. Public for
     the same reason the tutorial is: it is read by somebody deciding whether
     this app would save them any typing at all, which is a decision made before
     signing up rather than after. */
  '/sms',
  /* The privacy statement. Requiring an account to read what an account would
     expose is the wrong way round — and the page is written for the person
     deciding whether to open one. */
  '/privacy',
  /* How to have an account erased. The person most likely to need it is the one
     who has already uninstalled or cannot get back in — exactly the person a
     route inside the app cannot serve. Both app stores require the URL too. */
  '/delete-account',
  /* Chrome fetches this with no cookies before it will drop the address bar in
     the Android wrapper. A redirect to /login here is an app that looks like a
     browser forever. */
  '/.well-known',
  '/en',
  /* A shared statement. Opened by somebody with no account and no reason to
     want one — a relative you lent money to, an insurer you pay a premium to.
     Bouncing them to /login would make the link useless, which is the whole
     feature. The token in the path is the credential; see
     `StatementShareService`. */
  '/s',
];

/**
 * Route guard. The refresh cookie is the durable session marker — the 15-minute
 * access cookie may well have expired by the time a tab is reopened, and the
 * API refreshes it on the first 401.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const hasSession = Boolean(request.cookies.get('hishab_rt')?.value);

  /* `/` is two different pages depending on who is asking: the dashboard for
   * somebody signed in, the landing page for everybody else.
   *
   * A rewrite rather than a redirect, so the URL a visitor arrived on and the
   * URL a crawler indexes are both `takatracker.com/` — the address that will
   * be printed, linked and searched for. Redirecting to `/home` would make the
   * canonical page one nobody types, and would cost every first-time visitor a
   * round trip before they saw a single word. */
  if (pathname === '/' && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/home';
    return NextResponse.rewrite(url);
  }

  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

/**
 * `robots.txt`, `sitemap.xml` and `llms.txt` are excluded for the same reason
 * the icons are: they are not screens, and the guard below would answer a
 * crawler's request for them with a redirect to `/login`. That is not a small
 * thing — a `robots.txt` that 307s is a `robots.txt` nothing can read, and the
 * sitemap it points at was equally unreachable. `llms.txt` fails more quietly
 * still: the redirect lands on the login page, which returns 200 and HTML, so
 * whatever fetched it gets a sign-in form it will happily summarise as the
 * product.
 */
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|icons|favicon.ico|manifest.webmanifest|sw.js|robots.txt|sitemap.xml|llms.txt).*)',
  ],
};
