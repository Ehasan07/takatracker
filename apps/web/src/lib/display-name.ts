'use client';

import * as React from 'react';
import { compareByDisplayName, displayName, type BilingualName } from '@hishab/shared';
import { useWorkspaceSettings } from '@/lib/workspace-settings';

/**
 * A category's or tag's name, in the language this workspace reads.
 *
 * ## Why a hook and not a bare function
 *
 * The resolution rule lives in `@hishab/shared` and is shared with the API, so
 * a report row and the picker that filed it can never disagree. What the hook
 * adds is the locale, read from the same cached `['me']` query the currency and
 * the greeting already use — so no screen has to thread a locale through its
 * props to render a name, and no screen can render one having forgotten to.
 *
 * ## The pair is returned together
 *
 * `name` and `compare` come back from one call, for the same reason `useMoney`
 * hands back format and parse together: a list sorted by one language and
 * labelled in the other is a list whose order looks random.
 */
export function useDisplayName(): {
  name: (row: BilingualName) => string;
  compare: (a: BilingualName, b: BilingualName) => number;
} {
  const { locale } = useWorkspaceSettings();
  return React.useMemo(
    () => ({
      name: (row: BilingualName) => displayName(row, locale),
      compare: (a: BilingualName, b: BilingualName) => compareByDisplayName(a, b, locale),
    }),
    [locale],
  );
}
