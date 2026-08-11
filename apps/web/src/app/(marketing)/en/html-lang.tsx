'use client';

import * as React from 'react';

/** Sets `<html lang>` and puts it back on the way out. See `layout.tsx`. */
export function HtmlLang({ lang }: { lang: string }) {
  React.useEffect(() => {
    const root = document.documentElement;
    const previous = root.lang;
    root.lang = lang;
    /* Restored on unmount, because a client-side navigation from `/en` to `/`
       does not reload the document — without this the Bengali page would keep
       announcing itself as English for the rest of the session. */
    return () => {
      root.lang = previous;
    };
  }, [lang]);
  return null;
}
