import { NextResponse, type NextRequest } from 'next/server';

/**
 * Reachable without a session. `/verify`, `/forgot` and `/reset` have to be
 * here: they are opened from an email link, by definition on a device that is
 * not signed in. Bouncing them to /login would also drop the `?token=`, which
 * the redirect below does not carry — so the link would be spent for nothing
 * and the user would have to request another.
 */
const PUBLIC_PATHS = ['/login', '/signup', '/offline', '/verify', '/forgot', '/reset'];

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
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|icons|favicon.ico|manifest.webmanifest|sw.js).*)'],
};
