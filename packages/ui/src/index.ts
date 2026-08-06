/**
 * Design tokens shared by web and mobile. One palette, one type scale, one
 * spacing scale — no per-app forks. The CSS mirror lives in `./tokens.css`.
 *
 * Ledger aesthetic: ink on paper, greenbar rows, a brass rule down the amount
 * column. Money is always tabular monospace, right-aligned.
 */

export const colors = {
  light: {
    ink: '#17251E',
    inkMuted: '#5A6B62',
    paper: '#FAFBF7',
    surface: '#FFFFFF',
    greenbar: '#F1F5EC',
    rule: '#D6DED0',
    income: '#1F6F4A',
    expense: '#A8342A',
    brass: '#8E6C18',
    accent: '#1F6F4A',
    danger: '#A8342A',
    warning: '#8E6C18',
  },
  dark: {
    ink: '#E8EFE7',
    inkMuted: '#9AAB9F',
    paper: '#101614',
    surface: '#16201C',
    greenbar: '#1A241F',
    rule: '#2C3A33',
    income: '#63C295',
    expense: '#E58B80',
    brass: '#D6AC4E',
    accent: '#63C295',
    danger: '#E58B80',
    warning: '#D6AC4E',
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
} as const;

export const radii = { sm: 4, md: 8, lg: 12, pill: 999 } as const;

export const fontSize = {
  xs: 12,
  sm: 13,
  base: 15,
  lg: 17,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
} as const;

/** Minimum touch target, per spec §5 and §10. */
export const TOUCH_TARGET_MIN = 44;

export const breakpoints = {
  smallPhone: 320,
  phone: 480,
  tablet: 768,
  desktop: 1024,
} as const;

export const fontFamily = {
  /** Bengali-capable UI face with a Latin fallback chain. */
  sans: "'Noto Sans Bengali', 'Hind Siliguri', ui-sans-serif, system-ui, sans-serif",
  /** Tabular figures — every amount column lines up. */
  mono: "ui-monospace, 'SF Mono', 'Roboto Mono', 'Courier New', monospace",
} as const;

export type ColorScheme = keyof typeof colors;
export type ColorToken = keyof (typeof colors)['light'];
