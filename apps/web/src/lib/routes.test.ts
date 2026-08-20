import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every internal link points at a page that exists.
 *
 * ## Why this is a test and not a code review
 *
 * A `<Link href="/accounts/abc">` to a route nobody wrote is not a type error,
 * not a build error and not a warning. It renders, it is clickable, and what it
 * gives the person who taps it is Next's black 404 — no header, no navigation,
 * no Bengali, nothing to say what happened or how to get back. The route it
 * needed was `/accounts/[id]/statement` and the difference is one path segment.
 *
 * Nothing else in the toolchain looks at this. TypeScript checks the shape of
 * the props, not the meaning of the string inside them; the e2e suite only
 * catches a dead link somebody thought to click. So the whole class is checked
 * here instead, off the source, the same way `t.test.ts` checks that every
 * translation key a screen asks for exists.
 *
 * ## What counts as a route
 *
 * A directory under `src/app` holding a `page.tsx`, with the route-group
 * parentheses — `(shell)`, `(marketing)` — dropped, because they organise files
 * and do not appear in a URL. A `[id]` segment matches anything, so
 * `/loans/${loan.id}` is checked against the shape `/loans/[id]` rather than
 * against a literal.
 */

const ROOT = join(process.cwd(), 'src', 'app');

/** Every URL this app can actually serve, `[id]` segments and all. */
function routes(): string[] {
  const found: string[] = [];
  const walk = (dir: string, url: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) {
        if (entry === 'page.tsx') found.push(url || '/');
        continue;
      }
      /* `(shell)` and friends group files without appearing in the URL; `@slot`
         and `_private` never appear either. */
      const segment = /^[([@_]/.test(entry) && entry.startsWith('(') ? '' : `/${entry}`;
      walk(full, url + segment);
    }
  };
  walk(ROOT, '');
  return found;
}

/** Source files that could carry a link. */
function sources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
    }
  };
  walk(join(process.cwd(), 'src'));
  return found;
}

/**
 * Internal paths, from `href` and from the router.
 *
 * A template literal keeps its shape: `${x}` becomes `[id]`, so a link built
 * from an id is compared against the dynamic route that serves it. Query
 * strings and hashes are cut — `/transactions?tagId=…` is the transactions
 * page — and anything reaching outside the app is left alone.
 */
function linkedPaths(source: string): string[] {
  const found = new Set<string>();

  const quoted = /(?:href|route)\s*[:=]\s*\{?\s*'(\/[^']*)'/g;
  const doubled = /(?:href|route)\s*[:=]\s*"(\/[^"]*)"/g;
  const templated = /(?:href=\{|router\.(?:push|replace)\()`(\/[^`]*)`/g;
  const pushed = /router\.(?:push|replace)\('(\/[^']*)'/g;

  for (const re of [quoted, doubled, templated, pushed]) {
    for (const match of source.matchAll(re)) {
      const raw = (match[1] as string).split('?')[0]!.split('#')[0]!;
      /* `${…}` is an id, a code, a token — whatever it is, the route that
         serves it is a dynamic segment. */
      const shaped = raw.replace(/\$\{[^}]*\}/g, '[id]');
      if (shaped.startsWith('//')) continue;
      found.add(shaped.length > 1 ? shaped.replace(/\/$/, '') : '/');
    }
  }
  return [...found];
}

/** Does a real route serve this path? `[id]` matches any single segment. */
function served(path: string, all: readonly string[]): boolean {
  const wanted = path.split('/').filter(Boolean);
  return all.some((route) => {
    const parts = route.split('/').filter(Boolean);
    if (parts.length !== wanted.length) return false;
    return parts.every((part, i) => part.startsWith('[') || part === wanted[i]);
  });
}

/**
 * Paths served by something other than a page.
 *
 * `/api/*` is the Next rewrite to the API; the rest are files with routes of
 * their own — a robots.txt, a manifest, an icon. None of them is a 404 and
 * none of them has a `page.tsx`.
 */
const NOT_PAGES = ['/api', '/llms.txt', '/robots.txt', '/sitemap.xml', '/manifest.webmanifest'];

describe('internal links', () => {
  it('all point at a page that exists', () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(20);

    const dead: string[] = [];
    for (const file of sources()) {
      for (const path of linkedPaths(readFileSync(file, 'utf8'))) {
        if (NOT_PAGES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
        if (!served(path, all)) dead.push(`${file.replace(process.cwd(), '')} → ${path}`);
      }
    }

    /* The one that shipped: the সম্পদ screen linked every asset to
       `/accounts/[id]`, which nobody ever wrote, so tapping a row gave Next's
       black 404 instead of the account. */
    expect(dead.sort()).toEqual([]);
  });
});
