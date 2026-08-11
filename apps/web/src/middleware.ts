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
 * `robots.txt` and `sitemap.xml` are excluded for the same reason the icons
 * are: they are not screens, and the guard below would answer a crawler's
 * request for them with a redirect to `/login`. That is not a small thing —
 * a `robots.txt` that 307s is a `robots.txt` nothing can read, and the sitemap
 * it points at was equally unreachable.
 */
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|icons|favicon.ico|manifest.webmanifest|sw.js|robots.txt|sitemap.xml).*)',
  ],
};
