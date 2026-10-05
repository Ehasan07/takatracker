import * as React from 'react';

/**
 * What the app looks like, on two axes that do not overlap.
 *
 * ## Palette, and separately light or dark
 *
 * A reader picks a *palette* — the colours — and, independently, whether those
 * colours are laid on paper or on ink. Folding the two into one list of eight
 * buttons was the first shape of this and it was wrong: "black and white" and
 * "dark" are not alternatives to one another, and somebody who wants the quiet
 * palette at night should not have to give up one to get the other.
 *
 * The four palettes and the reasoning behind each are in
 * `packages/ui/src/tokens.css`, next to the colours themselves.
 *
 * ## Where the state actually lives
 *
 * On `<html>`, as `data-theme` and `data-mode`, and nowhere else. React holds a
 * copy purely so the settings screen can draw a tick beside the current choice;
 * nothing renders from it. That is what lets the palette be applied by six
 * lines of script before React exists — see `APPEARANCE_BOOT` — and it is why
 * there is no context provider here. A provider would need every screen inside
 * it and would buy nothing: the cascade is already the broadcast mechanism.
 *
 * ## localStorage, not the server
 *
 * The choice is the device's, not the workspace's. Two people sharing one set
 * of books must agree on the *language* — a report one mails the other has to
 * read the same both ends — but they need not agree on whether the app is dark,
 * and one of them switching to black-and-white on their own phone is not an
 * edit to shared data. It also means no round trip before the first paint,
 * which is the whole game here.
 *
 * ## No `'use client'` at the top, on purpose
 *
 * The root layout is a server component and it needs `APPEARANCE_BOOT` as an
 * actual string. Every export of a `'use client'` module reaches a server
 * component as a client *reference* rather than its value, so the directive
 * here would hand the layout an opaque object to inline into a script tag. The
 * hook below is still client-only — it is simply the importing component that
 * declares that, which is where the boundary belongs anyway.
 */

export const THEMES = ['default', 'mono', 'contrast', 'calm'] as const;
export type Theme = (typeof THEMES)[number];

export const MODES = ['system', 'light', 'dark'] as const;
export type Mode = (typeof MODES)[number];

/* Spelled out again as literals inside `applyStoredAppearance` below, which
   cannot reference a module constant — see the note on its self-containment.
   Renaming either key means changing it in both places. */
export const THEME_KEY = 'hishab.theme';
export const MODE_KEY = 'hishab.mode';

/**
 * Reads the stored choice and puts it on `<html>`. The single source of truth
 * for how a stored string becomes two attributes.
 *
 * It is deliberately self-contained — no imports, no module constants, no
 * helpers — because `APPEARANCE_BOOT` stringifies this exact function into the
 * blocking script tag in the document head. Anything it closed over would be
 * undefined by the time that copy ran. In exchange, the code that paints the
 * theme before React loads and the code that repaints it when a button is
 * pressed cannot drift apart, which is precisely how the previous version
 * broke: the layout applied one rule and the settings screen applied another,
 * and every route outside settings ignored the reader's choice entirely.
 *
 * ## Why `data-mode` is resolved here and not in a media query
 *
 * `prefers-color-scheme` is asked exactly once, right here, and the answer is
 * written out as a plain `light` or `dark`. The stylesheet therefore needs no
 * media queries at all. A reader who has chosen nothing gets the light face
 * whatever their phone is set to — the owner's call: the product is meant to be
 * seen on paper-white, and a dark-mode phone was turning it dark for everyone.
 * Choosing `system` hands the decision to the OS, and `dark` is one tap away.
 * The alternative, every palette written twice
 * (once behind an attribute, once behind a media query), is eight faces of
 * duplication and eight chances for the two copies to disagree.
 */
function applyStoredAppearance(): void {
  try {
    let theme = localStorage.getItem('hishab.theme');
    let mode = localStorage.getItem('hishab.mode');

    /* `hishab.theme` used to hold the light/dark choice, back when that was the
       only choice there was. A returning reader who set dark last year still
       has `'dark'` sitting in that key, and reading it as a palette name would
       silently put them back on the default light theme. */
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      if (mode === null) mode = theme;
      theme = null;
    }

    if (theme !== 'mono' && theme !== 'contrast' && theme !== 'calm') theme = 'default';
    const dark =
      mode === 'dark' ||
      (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-mode', dark ? 'dark' : 'light');
  } catch {
    /* A locked-down cookie jar, private browsing on an old Safari, a webview
       with storage disabled. The page then renders in the default light
       palette, which is a theme rather than a failure. */
  }
}

/**
 * The blocking script, and why it has to be one.
 *
 * It goes in `<head>`, before anything paints. A theme applied from a React
 * effect is applied one frame too late, and that frame is a full white screen
 * on a dark-theme phone every single time the app is opened — the flash people
 * describe as the app "blinking". There is no way around a synchronous script:
 * the correct colours depend on localStorage, and the server that rendered the
 * HTML cannot read it.
 *
 * `theme-color` is deliberately left alone. The two media-scoped tags in the
 * layout are right whenever the app follows the OS, which is the default and
 * the common case; rewriting them here for somebody who has overridden the OS
 * holds only until the first client-side navigation, when Next re-renders its
 * own metadata and puts them back. A tint that is right on launch and flips on
 * the first tap is worse than one that is consistently OS-driven.
 *
 * The `change` listener on the end is what keeps `system` honest for the length
 * of a session: phones flip to dark on a schedule, and an app left open across
 * sunset should follow. It re-runs the same function rather than closing over
 * the values it read, so it is still right after the reader has changed the
 * setting by hand in the meantime.
 */
export const APPEARANCE_BOOT = `(function(){var a=${applyStoredAppearance.toString()};a();try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',a)}catch(e){}})();`;

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return (THEMES as readonly string[]).includes(value ?? '') ? (value as Theme) : 'default';
  } catch {
    return 'default';
  }
}

function storedMode(): Mode {
  try {
    const value = localStorage.getItem(MODE_KEY) ?? localStorage.getItem(THEME_KEY);
    return (MODES as readonly string[]).includes(value ?? '') ? (value as Mode) : 'light';
  } catch {
    return 'light';
  }
}

/** What the reader chose, for a screen that has to draw a tick beside it. */
export function useAppearance(): {
  theme: Theme;
  mode: Mode;
  /** False until the first effect has run; before that, nothing is ticked. */
  ready: boolean;
  setTheme: (next: Theme) => void;
  setMode: (next: Mode) => void;
} {
  const [theme, setThemeState] = React.useState<Theme>('default');
  const [mode, setModeState] = React.useState<Mode>('light');
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const currentTheme = storedTheme();
    const currentMode = storedMode();
    setThemeState(currentTheme);
    setModeState(currentMode);
    setReady(true);

    /* Rewrites the legacy single-key form into the two-key one.
     *
     * Without it, a reader who had chosen dark last year and now picks the
     * black-and-white palette would lose the dark: the palette write lands on
     * `hishab.theme`, which is where their old `'dark'` was, and nothing ever
     * moved it to `hishab.mode`. Doing it here rather than in the boot script
     * keeps a synchronous storage write off the critical path. */
    try {
      localStorage.setItem(THEME_KEY, currentTheme);
      localStorage.setItem(MODE_KEY, currentMode);
    } catch {
      /* Same unwritable storage as above; the choice lasts this session. */
    }
  }, []);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* Applied anyway, just not remembered. */
    }
    applyStoredAppearance();
  }, []);

  const setMode = React.useCallback((next: Mode) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* Applied anyway, just not remembered. */
    }
    applyStoredAppearance();
  }, []);

  return { theme, mode, ready, setTheme, setMode };
}
