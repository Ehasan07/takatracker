import type { NextRequest } from 'next/server';

/**
 * Same-origin proxy to the NestJS API.
 *
 * The browser only ever talks to its own origin, so session cookies are
 * first-party and there is no CORS preflight. This is a route handler rather
 * than a `next.config` rewrite because rewrites are baked into the build
 * manifest — the API address has to be resolvable at runtime so the same build
 * can be deployed anywhere.
 *
 * In production nginx short-circuits `/api/` straight to the API and this
 * handler is only the fallback.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'upgrade',
  'host',
]);

function apiBase(): string {
  return process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
}

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const target = new URL(`${apiBase()}/${path.join('/')}`);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) headers.set(key, value);
  });
  headers.set('x-forwarded-host', request.nextUrl.host);
  headers.set('x-forwarded-proto', request.nextUrl.protocol.replace(':', ''));

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json({ message: 'API সাড়া দিচ্ছে না' }, { status: 502 });
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (key === 'set-cookie' || HOP_BY_HOP.has(key)) return;
    outHeaders.set(key, value);
  });
  // Each Set-Cookie must stay its own header — joining them breaks the session.
  for (const cookie of upstream.headers.getSetCookie()) {
    outHeaders.append('set-cookie', cookie);
  }
  // Belt and braces with the API's own header: never let a balance be cached.
  outHeaders.set('cache-control', 'no-store, no-cache, must-revalidate, private');

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

type Context = { params: Promise<{ path: string[] }> };

const handler = async (request: NextRequest, context: Context): Promise<Response> => {
  const { path } = await context.params;
  return proxy(request, path);
};

export {
  handler as GET,
  handler as POST,
  handler as PATCH,
  handler as PUT,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
