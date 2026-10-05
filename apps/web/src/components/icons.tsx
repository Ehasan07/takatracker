/**
 * The product's own icon set.
 *
 * Drawn for this app on one grid — 24 units, 1.8 stroke, round caps and joins —
 * in place of a stock set that every other site ships. The signature is the
 * logo's: wherever an icon is about money, a place money lives, or a figure,
 * one small part of it is the mark's gold (`--hishab-gold`, so it turns grey in
 * the black-and-white palette like everything else). Plain controls — a close
 * cross, a chevron, an arrow — carry no gold; they are punctuation, not
 * pictures.
 *
 * Every export keeps the name and props of the lucide-react icon it replaces,
 * so a screen changes its import line and nothing else.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export type IconProps = React.SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
  /** Accepted for compatibility with the set this replaces; strokes here are
      always drawn in the 24-unit space. */
  absoluteStrokeWidth?: boolean;
};

export type LucideIcon = React.ForwardRefExoticComponent<
  Omit<IconProps, 'ref'> & React.RefAttributes<SVGSVGElement>
>;

const GOLD = 'var(--hishab-gold)';
/** A stroke in the mark's gold. */
const g = { stroke: GOLD } as const;
/** A filled dot in the mark's gold. */
const gd = { fill: GOLD, stroke: 'none' } as const;
/** A filled dot in the icon's own colour. */
const ink = { fill: 'currentColor', stroke: 'none' } as const;

function icon(name: string, body: React.ReactNode): LucideIcon {
  const Icon = React.forwardRef<SVGSVGElement, IconProps>(
    (
      {
        size = 24,
        strokeWidth = 1.8,
        absoluteStrokeWidth: _absolute,
        className,
        children,
        ...rest
      },
      ref,
    ) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn('tt-icon', className)}
        {...rest}
      >
        {body}
        {children}
      </svg>
    ),
  );
  Icon.displayName = name;
  return Icon;
}

/* ---- shared outlines ------------------------------------------------------ */

const FILE = (
  <>
    <path d="M6.5 3.5h7l4 4v13h-11Z" />
    <path d="M13.5 3.5v4h4" />
  </>
);
const SHIELD = <path d="M12 3.5 5 6.5v5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9v-5Z" />;
const RING = <circle cx="12" cy="12" r="8.5" />;
const BOX = (
  <>
    <path d="m12 3 8 4.3v9.4L12 21l-8-4.3V7.3Z" />
    <path d="M4 7.3 12 11.6l8-4.3M12 11.6V21" />
  </>
);
const ARCHIVE = (
  <>
    <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
    <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5" />
  </>
);
const TAG = (
  <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.4 1.4 0 0 1 0 2l-6.7 6.7a1.4 1.4 0 0 1-2 0Z" />
);
const PERSON = (
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  </>
);
const PEOPLE = (
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3a6.5 6.5 0 0 1 3.5 5.7" />
  </>
);
const TRIANGLE = (
  <>
    <path d="M10.3 4.2 2.9 17.3a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4" />
    <circle cx="12" cy="16.8" r="1.1" {...gd} />
  </>
);
const CIRCLE_CHECK = (
  <>
    {RING}
    <path d="m8.3 12.3 2.6 2.6 5-5.2" />
  </>
);
const SPLIT = (
  <>
    {RING}
    <path d="M12 3.5V12l6 6" />
    <path d="M12 12V3.5a8.5 8.5 0 0 1 6 14.5Z" {...gd} />
  </>
);

/* ---- controls ------------------------------------------------------------- */

export const X = icon('X', <path d="M6 6l12 12M18 6 6 18" />);
export const Plus = icon('Plus', <path d="M12 5v14M5 12h14" />);
export const Minus = icon('Minus', <path d="M5 12h14" />);
export const Check = icon('Check', <path d="m5 12.5 4.5 4.5L19 7.5" />);
export const ChevronDown = icon('ChevronDown', <path d="m6 9 6 6 6-6" />);
export const ChevronLeft = icon('ChevronLeft', <path d="m15 6-6 6 6 6" />);
export const ChevronRight = icon('ChevronRight', <path d="m9 6 6 6-6 6" />);
export const ArrowDown = icon('ArrowDown', <path d="M12 5v14M6 13l6 6 6-6" />);
export const ArrowUp = icon('ArrowUp', <path d="M12 19V5M6 11l6-6 6 6" />);
export const ArrowLeft = icon('ArrowLeft', <path d="M19 12H5M11 6l-6 6 6 6" />);
export const ArrowRight = icon('ArrowRight', <path d="M5 12h14M13 6l6 6-6 6" />);
export const ArrowUpRight = icon('ArrowUpRight', <path d="M7 17 17 7M9 7h8v8" />);
export const ArrowDownRight = icon('ArrowDownRight', <path d="M7 7l10 10M17 9v8H9" />);
export const ArrowDownLeft = icon('ArrowDownLeft', <path d="M17 7 7 17M15 17H7V9" />);
export const ArrowUpDown = icon(
  'ArrowUpDown',
  <path d="M8 4v16M4.5 7.5 8 4l3.5 3.5M16 20V4M12.5 16.5 16 20l3.5-3.5" />,
);
export const CornerDownRight = icon(
  'CornerDownRight',
  <path d="M5 4v8a3 3 0 0 0 3 3h11M15 11l4 4-4 4" />,
);
export const ExternalLink = icon(
  'ExternalLink',
  <>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </>,
);
export const Menu = icon('Menu', <path d="M4 7h16M4 12h16M4 17h10" />);
export const Ellipsis = icon(
  'Ellipsis',
  <>
    <circle cx="6" cy="12" r="1.6" {...ink} />
    <circle cx="12" cy="12" r="1.6" {...ink} />
    <circle cx="18" cy="12" r="1.6" {...gd} />
  </>,
);
export const Search = icon(
  'Search',
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </>,
);
export const Filter = icon('Filter', <path d="M4 5h16l-6 7.5V19l-4 1.5v-8Z" />);
export const ListFilter = icon('ListFilter', <path d="M4 6h16M7 12h10M10 18h4" />);
export const SlidersHorizontal = icon(
  'SlidersHorizontal',
  <>
    <path d="M4 7h16M4 12h16M4 17h16" />
    <circle cx="9" cy="7" r="2.2" fill="var(--hishab-surface)" />
    <circle cx="15.5" cy="12" r="2.2" fill={GOLD} />
    <circle cx="7" cy="17" r="2.2" fill="var(--hishab-surface)" />
  </>,
);
export const Pencil = icon(
  'Pencil',
  <>
    <path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    <path d="m13.5 6.5 3 3" />
  </>,
);
export const Trash2 = icon(
  'Trash2',
  <>
    <path d="M4 6.5h16M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
    <path d="M6 6.5 7 19a1.6 1.6 0 0 0 1.6 1.5h6.8A1.6 1.6 0 0 0 17 19l1-12.5" />
    <path d="M10 10.5v6M14 10.5v6" />
  </>,
);
export const Delete = icon(
  'Delete',
  <>
    <path d="M9 5h10.5A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5H9l-6-7Z" />
    <path d="m12 9.5 5 5m0-5-5 5" />
  </>,
);
export const Copy = icon(
  'Copy',
  <>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
  </>,
);
export const Undo2 = icon(
  'Undo2',
  <>
    <path d="M9 14 4.5 9.5 9 5" />
    <path d="M4.5 9.5H15a4.5 4.5 0 0 1 0 9h-3" />
  </>,
);
export const RotateCw = icon(
  'RotateCw',
  <>
    <path d="M20 12a8 8 0 1 1-2.5-5.8L20 8.5" />
    <path d="M20 4v4.5h-4.5" />
  </>,
);
export const RotateCcw = icon(
  'RotateCcw',
  <>
    <path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5" />
    <path d="M4 4v4.5h4.5" />
  </>,
);
export const RefreshCw = icon(
  'RefreshCw',
  <>
    <path d="M20 11a8 8 0 0 0-14.2-4.5L4 8.5" />
    <path d="M4 4v4.5h4.5" />
    <path d="M4 13a8 8 0 0 0 14.2 4.5l1.8-2" />
    <path d="M20 20v-4.5h-4.5" />
  </>,
);
export const Download = icon(
  'Download',
  <>
    <path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5" />
    <path d="M4.5 19.5h15" {...g} />
  </>,
);
export const Upload = icon(
  'Upload',
  <>
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4.5 19.5h15" {...g} />
  </>,
);
export const Send = icon(
  'Send',
  <>
    <path d="M20.5 3.5 10 14" />
    <path d="m20.5 3.5-6.5 17-4-6.5-6.5-4Z" />
  </>,
);
export const Share2 = icon(
  'Share2',
  <>
    <circle cx="18" cy="5.5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="18.5" r="2.5" />
    <path d="m8.2 10.8 7.6-4M8.2 13.2l7.6 4" />
    <circle cx="6" cy="12" r="1" {...gd} />
  </>,
);
export const Link2 = icon(
  'Link2',
  <>
    <path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 0 10h-2" />
    <path d="M8.5 12h7" {...g} />
  </>,
);
export const Paperclip = icon(
  'Paperclip',
  <path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1L13.3 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />,
);
export const Merge = icon(
  'Merge',
  <>
    <path d="M7 3.5V8a4 4 0 0 0 1.2 2.8L12 14.5v6" />
    <path d="M17 3.5V8a4 4 0 0 1-1.2 2.8L13.5 13" />
    <path d="M4.5 6 7 3.5 9.5 6M14.5 6 17 3.5 19.5 6" />
  </>,
);
export const Eye = icon(
  'Eye',
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="12" r="1" {...gd} />
  </>,
);
export const EyeOff = icon(
  'EyeOff',
  <>
    <path d="M10.6 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.6 16.6 0 0 1-2.3 3.1M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.4-1.1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </>,
);
export const Power = icon(
  'Power',
  <>
    <path d="M12 3.5V11" />
    <path d="M7 6.5a7.5 7.5 0 1 0 10 0" />
  </>,
);
export const LogOut = icon(
  'LogOut',
  <>
    <path d="M9.5 20.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5h3.5" />
    <path d="M15.5 16.5 20 12l-4.5-4.5M20 12H9.5" />
  </>,
);
export const PauseCircle = icon(
  'PauseCircle',
  <>
    {RING}
    <path d="M10 9v6M14 9v6" />
  </>,
);
export const PlayCircle = icon(
  'PlayCircle',
  <>
    {RING}
    <path d="m10 8.5 5.5 3.5-5.5 3.5Z" />
  </>,
);
export const Ban = icon(
  'Ban',
  <>
    {RING}
    <path d="m6 6 12 12" />
  </>,
);

/* ---- status --------------------------------------------------------------- */

export const TriangleAlert = icon('TriangleAlert', TRIANGLE);
export const AlertTriangle = icon('AlertTriangle', TRIANGLE);
export const CircleCheck = icon('CircleCheck', CIRCLE_CHECK);
export const CheckCircle2 = icon('CheckCircle2', CIRCLE_CHECK);
export const CircleAlert = icon(
  'CircleAlert',
  <>
    {RING}
    <path d="M12 7.5v5" />
    <circle cx="12" cy="16" r="1.1" {...ink} />
  </>,
);
export const CircleHelp = icon(
  'CircleHelp',
  <>
    {RING}
    <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7" />
    <circle cx="12" cy="17" r="1.1" {...gd} />
  </>,
);
export const Info = icon(
  'Info',
  <>
    {RING}
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.8" r="1.1" {...gd} />
  </>,
);
export const Clock = icon(
  'Clock',
  <>
    {RING}
    <path d="M12 7.5V12l3 2" {...g} />
  </>,
);
export const History = icon(
  'History',
  <>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
    <path d="M3.5 4v4h4" />
    <path d="M12 8v4l2.8 1.8" {...g} />
  </>,
);
export const Bell = icon(
  'Bell',
  <>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" {...g} />
  </>,
);
export const BellOff = icon(
  'BellOff',
  <>
    <path d="M8.5 5.5A6 6 0 0 1 18 11v5" />
    <path d="M6 11v5.5l-1.5 2H17" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
    <path d="m3 3 18 18" />
  </>,
);
export const BadgeCheck = icon(
  'BadgeCheck',
  <>
    <path d="m12 2.8 2.2 1.8 2.8-.3.8 2.7 2.5 1.4-.7 2.8 1.2 2.6-2.1 1.8-.3 2.8-2.8.5L14 21.2l-2-1-2 1-1.6-2.3-2.8-.5-.3-2.8-2.1-1.8 1.2-2.6-.7-2.8L6.2 7l.8-2.7 2.8.3Z" />
    <path d="m9 12 2.2 2.2L15.2 10" {...g} />
  </>,
);
export const ShieldCheck = icon(
  'ShieldCheck',
  <>
    {SHIELD}
    <path d="m9 12.2 2.2 2.2L15.4 10" {...g} />
  </>,
);
export const ShieldAlert = icon(
  'ShieldAlert',
  <>
    {SHIELD}
    <path d="M12 8.5v4" />
    <circle cx="12" cy="15.6" r="1.1" {...gd} />
  </>,
);
export const Lock = icon(
  'Lock',
  <>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <circle cx="12" cy="15.5" r="1.4" {...gd} />
  </>,
);
export const KeyRound = icon(
  'KeyRound',
  <>
    <circle cx="8.5" cy="15.5" r="4.5" />
    <path d="m11.7 12.3 8.3-8.3M17 7l2.5 2.5M14.5 9.5l2 2" />
    <circle cx="8.5" cy="15.5" r="1.3" {...gd} />
  </>,
);
export const CloudOff = icon(
  'CloudOff',
  <>
    <path d="M7.5 18.5H17a3.5 3.5 0 0 0 1.4-6.7A5.5 5.5 0 0 0 9 8.6" />
    <path d="M6 10a4.3 4.3 0 0 0 1.5 8.5" />
    <path d="m3 3 18 18" />
  </>,
);
export const Unplug = icon(
  'Unplug',
  <>
    <path d="m19 5 2-2M5 19l-2 2" />
    <path d="M6.5 12.5l5 5L10 19a3.5 3.5 0 0 1-5-5Z" />
    <path d="M17.5 11.5l-5-5L14 5a3.5 3.5 0 0 1 5 5Z" />
    <path d="m7.5 10 2-2M10 14.5l2-2" {...g} />
  </>,
);
export const Sparkles = icon(
  'Sparkles',
  <>
    <path d="M12 3.5 13.6 8.4 18.5 10 13.6 11.6 12 16.5 10.4 11.6 5.5 10 10.4 8.4Z" />
    <path d="M18.5 15.5v4M16.5 17.5h4" {...g} />
    <path d="M5.5 16v2.5M4.2 17.2h2.6" />
  </>,
);
export const LifeBuoy = icon(
  'LifeBuoy',
  <>
    {RING}
    <circle cx="12" cy="12" r="3.5" />
    <path d="m6 6 3.5 3.5M14.5 14.5 18 18M18 6l-3.5 3.5M9.5 14.5 6 18" />
  </>,
);
const InfinityIcon = icon(
  'Infinity',
  <path d="M12 12c-2-2.7-3.7-4-5.5-4a4 4 0 0 0 0 8c1.8 0 3.5-1.3 5.5-4Zm0 0c2 2.7 3.7 4 5.5 4a4 4 0 0 0 0-8c-1.8 0-3.5 1.3-5.5 4Z" />,
);
export const Gauge = icon(
  'Gauge',
  <>
    <path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0" />
    <path d="m12 13.5 3.5-4" {...g} />
    <circle cx="12" cy="13.5" r="1.3" {...ink} />
  </>,
);

/* ---- money and the places it lives ----------------------------------------- */

export const Wallet = icon(
  'Wallet',
  <>
    <path d="M4 7.5h13.5a2.5 2.5 0 0 1 2.5 2.5v7.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5Z" />
    <path d="M4 7.5V7a2.5 2.5 0 0 1 2.5-2.5H15" />
    <circle cx="16" cy="13.75" r="1.6" {...gd} />
  </>,
);
export const Landmark = icon(
  'Landmark',
  <>
    <path d="M3.5 9 12 4.5 20.5 9Z" />
    <path d="M6.5 11.5v5M10.5 11.5v5M13.5 11.5v5M17.5 11.5v5" />
    <rect x="3.5" y="18.4" width="17" height="2.2" rx="1.1" {...gd} />
  </>,
);
export const CreditCard = icon(
  'CreditCard',
  <>
    <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
    <path d="M3 10h18" />
    <rect x="6" y="13.5" width="5" height="2" rx="1" {...gd} />
  </>,
);
export const Coins = icon(
  'Coins',
  <>
    <ellipse cx="9" cy="7" rx="5.5" ry="2.5" />
    <path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5M3.5 11v4c0 1.4 2.5 2.5 5.5 2.5" />
    <ellipse cx="15.5" cy="13" rx="5" ry="2.3" />
    <path d="M10.5 13v4c0 1.3 2.2 2.3 5 2.3s5-1 5-2.3v-4" />
    <path d="M14 13h3" {...g} />
  </>,
);
export const HandCoins = icon(
  'HandCoins',
  <>
    <path d="M3 14.5h3l3.2 1.6a2 2 0 0 0 .9.2H13a1.5 1.5 0 0 0 0-3h-2.5" />
    <path d="M6 19.5h7.5l5.7-3.5a1.6 1.6 0 0 0-1.7-2.7L13 15.5" />
    <path d="M3 13v8" />
    <circle cx="15.5" cy="7" r="3.5" {...g} />
  </>,
);
export const PiggyBank = icon(
  'PiggyBank',
  <>
    <path d="M19 10.5c1 0 1.5.5 1.5 1.5v1.5c0 .7-.6 1-1.3 1.2l-.7 1.8V19H16v-1.5h-5V19H8.5v-2.4A6 6 0 0 1 5 12a6 6 0 0 1 6-6h3.5a6 6 0 0 1 3.4 1.1L20 6.5l-.6 2.6" />
    <path d="M3 10.5c0 1.4.8 2 1.8 2" />
    <circle cx="16" cy="10.5" r="1" {...ink} />
    <path d="M10 8.8h3" {...g} />
  </>,
);
export const Receipt = icon(
  'Receipt',
  <>
    <path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z" />
    <path d="M9 8h6M9 11.5h6" />
    <path d="M9 15h3" {...g} />
  </>,
);
export const Calculator = icon(
  'Calculator',
  <>
    <rect x="5" y="2.8" width="14" height="18.4" rx="2.6" />
    <rect x="8" y="6" width="8" height="3.5" rx="1" {...gd} />
    <path
      d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.8h.01M12 16.8h.01M15.5 16.8h.01"
      strokeWidth={2.4}
    />
  </>,
);
export const Scale = icon(
  'Scale',
  <>
    <path d="M12 4v16M8 20h8M5 7h14" />
    <path d="m5 7-2.5 6a3 3 0 0 0 5 0Z" />
    <path d="m19 7-2.5 6a3 3 0 0 0 5 0Z" />
    <circle cx="12" cy="4" r="1.3" {...gd} />
  </>,
);
export const Briefcase = icon(
  'Briefcase',
  <>
    <rect x="3" y="7" width="18" height="13" rx="2.5" />
    <path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M3 12.5h18" />
    <rect x="10.5" y="11.3" width="3" height="2.6" rx=".8" {...gd} />
  </>,
);
export const Building2 = icon(
  'Building2',
  <>
    <path d="M5 21V5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 15 5v16" />
    <path d="M15 10h3.5a1.5 1.5 0 0 1 1.5 1.5V21" />
    <path d="M3 21h18M8.5 7.5h3M8.5 11h3M8.5 14.5h3" />
    <rect x="9" y="17.5" width="2.5" height="3.5" rx=".5" {...gd} />
  </>,
);
export const Car = icon(
  'Car',
  <>
    <path d="M5 12l1.8-4.5a2 2 0 0 1 1.9-1.3h6.6a2 2 0 0 1 1.9 1.3L19 12" />
    <rect x="3.5" y="12" width="17" height="5" rx="1.5" />
    <path d="M6 17v2M18 17v2" />
    <circle cx="7.5" cy="14.5" r="1" {...gd} />
    <circle cx="16.5" cy="14.5" r="1" {...gd} />
  </>,
);
export const Package = icon(
  'Package',
  <>
    {BOX}
    <path d="m8 5.2 8 4.3" {...g} />
  </>,
);
export const PackagePlus = icon(
  'PackagePlus',
  <>
    {BOX}
    <path d="M18.5 14v5M16 16.5h5" {...g} />
  </>,
);
export const PackageX = icon(
  'PackageX',
  <>
    {BOX}
    <path d="m16.5 15 4 4m0-4-4 4" {...g} />
  </>,
);
export const Archive = icon(
  'Archive',
  <>
    {ARCHIVE}
    <path d="M10 12.5h4" {...g} />
  </>,
);
export const ArchiveRestore = icon(
  'ArchiveRestore',
  <>
    {ARCHIVE}
    <path d="M12 17.5v-5.5m-2.5 2.5L12 12l2.5 2.5" {...g} />
  </>,
);
export const Split = icon('Split', SPLIT);
export const Tag = icon(
  'Tag',
  <>
    {TAG}
    <circle cx="8" cy="8" r="1.8" {...gd} />
  </>,
);
export const Tags = icon(
  'Tags',
  <>
    <path d="M3.5 11.2V4.5a1 1 0 0 1 1-1h6.7l7.8 7.8a1.4 1.4 0 0 1 0 2l-5.7 5.7a1.4 1.4 0 0 1-2 0Z" />
    <path d="m14.5 3.5 6.3 6.3a2 2 0 0 1 0 2.8l-4.8 4.8" />
    <circle cx="7.8" cy="7.8" r="1.6" {...gd} />
  </>,
);
export const Hash = icon('Hash', <path d="M9.5 4 8 20M16 4l-1.5 16M4.5 9h15M3.5 15h15" />);

/* ---- reports and figures --------------------------------------------------- */

export const ChartColumn = icon(
  'ChartColumn',
  <>
    <path d="M4 4v16h16" />
    <path d="M8.5 16.5v-4M12.5 16.5V9.5" strokeWidth={2.4} />
    <path d="M16.5 16.5v-10" strokeWidth={2.4} {...g} />
  </>,
);
export const LineChart = icon(
  'LineChart',
  <>
    <path d="M4 4v16h16" />
    <path d="m7.5 15 3.5-4 3 2.5 4.5-5.5" />
    <circle cx="18.5" cy="8" r="1.4" {...gd} />
  </>,
);
export const TrendingUp = icon(
  'TrendingUp',
  <>
    <path d="m3.5 17 6.5-6.5 3.5 3.5 7-7" />
    <path d="M20.5 11.5V7H16" />
  </>,
);
export const TrendingDown = icon(
  'TrendingDown',
  <>
    <path d="m3.5 7 6.5 6.5 3.5-3.5 7 7" />
    <path d="M20.5 12.5V17H16" />
  </>,
);
export const LayoutDashboard = icon(
  'LayoutDashboard',
  <>
    <rect x="3.5" y="3.5" width="7" height="9" rx="1.8" />
    <rect x="13.5" y="3.5" width="7" height="5" rx="1.8" />
    <rect x="13.5" y="11.5" width="7" height="9" rx="1.8" />
    <rect x="3.5" y="15.5" width="7" height="5" rx="1.8" {...gd} />
  </>,
);
export const LayoutGrid = icon(
  'LayoutGrid',
  <>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    <circle cx="17" cy="17" r="1.3" {...gd} />
  </>,
);
export const Layers = icon(
  'Layers',
  <>
    <path d="m12 3.5 8.5 4.5L12 12.5 3.5 8Z" />
    <path d="m3.5 12 8.5 4.5 8.5-4.5" />
    <path d="m3.5 16 8.5 4.5 8.5-4.5" {...g} />
  </>,
);
export const ListChecks = icon(
  'ListChecks',
  <>
    <path d="m3.5 6.5 1.5 1.5 3-3M3.5 13.5l1.5 1.5 3-3" />
    <path d="M11.5 7h9M11.5 14h9M11.5 19.5h9" />
    <circle cx="5.2" cy="19.5" r="1.1" {...gd} />
  </>,
);
export const Database = icon(
  'Database',
  <>
    <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
    <path d="M4.5 6v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6" />
    <path d="M4.5 12v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6" />
    <circle cx="17" cy="9.6" r="1" {...gd} />
  </>,
);

/* ---- documents and messages ------------------------------------------------ */

export const FileText = icon(
  'FileText',
  <>
    {FILE}
    <path d="M9 12h6M9 15.5h6" />
    <path d="M9 18.6h3" {...g} />
  </>,
);
export const FileDown = icon(
  'FileDown',
  <>
    {FILE}
    <path d="M12 11v6m-2.5-2.5L12 17l2.5-2.5" {...g} />
  </>,
);
export const FileUp = icon(
  'FileUp',
  <>
    {FILE}
    <path d="M12 17v-6m-2.5 2.5L12 11l2.5 2.5" {...g} />
  </>,
);
export const FileQuestion = icon(
  'FileQuestion',
  <>
    {FILE}
    <path d="M10.2 11.4a1.9 1.9 0 0 1 3.6.7c0 1.3-1.8 1.6-1.8 2.8" />
    <circle cx="12" cy="17.6" r="1" {...gd} />
  </>,
);
export const FileSpreadsheet = icon(
  'FileSpreadsheet',
  <>
    {FILE}
    <rect x="9" y="11.5" width="6" height="6" rx=".8" />
    <path d="M9 14.5h6M12 11.5v6" />
    <rect x="9.4" y="11.9" width="2.2" height="2.2" rx=".4" {...gd} />
  </>,
);
export const NotebookText = icon(
  'NotebookText',
  <>
    <path d="M6.5 3.5h11A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5h-11Z" />
    <path d="M4 7.5h3M4 12h3M4 16.5h3M10.5 8h5M10.5 11.5h5" />
    <path d="M10.5 15h3" {...g} />
  </>,
);
export const ScrollText = icon(
  'ScrollText',
  <>
    <path d="M8 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-1H10.5v1a2.5 2.5 0 0 1-5 0V6A2.5 2.5 0 0 0 3 3.5" />
    <path d="M3 3.5h12A2.5 2.5 0 0 1 17.5 6v11" />
    <path d="M8.5 8h5" />
    <path d="M8.5 11.5h3" {...g} />
  </>,
);
export const FolderInput = icon(
  'FolderInput',
  <>
    <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z" />
    <path d="M8 13.5h7m-2.5-2.5 2.5 2.5-2.5 2.5" {...g} />
  </>,
);
export const Inbox = icon(
  'Inbox',
  <>
    <path d="M3.5 13.5 6 5.5h12l2.5 8V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
    <path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5" />
  </>,
);
export const Mail = icon(
  'Mail',
  <>
    <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
    <path d="m3.8 7 8.2 6 8.2-6" />
  </>,
);
export const MailCheck = icon(
  'MailCheck',
  <>
    <path d="M20.5 12V8A2.5 2.5 0 0 0 18 5.5H6A2.5 2.5 0 0 0 3.5 8v8A2.5 2.5 0 0 0 6 18.5h6" />
    <path d="m4 7 8 5.5L20 7" />
    <path d="m15 17.5 2 2 4-4" {...g} />
  </>,
);
export const MessageSquareText = icon(
  'MessageSquareText',
  <>
    <path d="M5 4.5h14a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-8l-4.5 3.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
    <path d="M7.5 9h9M7.5 12.5h5" />
    <circle cx="16.4" cy="12.5" r="1.5" {...gd} />
  </>,
);
export const Quote = icon(
  'Quote',
  <>
    <path d="M9.5 6.5c-3 .8-5 3.3-5 6.5V17h5v-5H6.8" />
    <path d="M19.5 6.5c-3 .8-5 3.3-5 6.5V17h5v-5h-2.7" />
  </>,
);
export const Printer = icon(
  'Printer',
  <>
    <path d="M7 8V3.5h10V8" />
    <rect x="3.5" y="8" width="17" height="8.5" rx="2" />
    <path d="M7 14h10v6.5H7Z" />
    <circle cx="17" cy="11.2" r="1" {...gd} />
  </>,
);
export const CalendarRange = icon(
  'CalendarRange',
  <>
    <rect x="4" y="5" width="16" height="15" rx="2.5" />
    <path d="M4 10h16M8.5 3v4M15.5 3v4" />
    <path d="M8 14.5h8" {...g} />
  </>,
);
export const CalendarClock = icon(
  'CalendarClock',
  <>
    <path d="M20 10V7.5A2.5 2.5 0 0 0 17.5 5h-11A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20H11" />
    <path d="M4 10h16M8.5 3v4M15.5 3v4" />
    <circle cx="17" cy="17" r="4" />
    <path d="M17 15.3V17l1.2.9" {...g} />
  </>,
);
export const Camera = icon(
  'Camera',
  <>
    <path d="M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
    <circle cx="12" cy="13" r="3.5" />
    <circle cx="17.2" cy="9.4" r="1" {...gd} />
  </>,
);

/* ---- people, devices, settings -------------------------------------------- */

export const User = icon('User', PERSON);
export const UserRound = icon('UserRound', PERSON);
export const UserPlus = icon(
  'UserPlus',
  <>
    <circle cx="10" cy="8" r="4" />
    <path d="M3 20.5a7 7 0 0 1 12.5-4.3" />
    <path d="M18.5 14v6M15.5 17h6" {...g} />
  </>,
);
export const Users = icon('Users', PEOPLE);
export const UsersRound = icon('UsersRound', PEOPLE);
export const Smartphone = icon(
  'Smartphone',
  <>
    <rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6" />
    <path d="M10 18.1h4" {...g} />
  </>,
);
export const Tablet = icon(
  'Tablet',
  <>
    <rect x="4.5" y="2.8" width="15" height="18.4" rx="2.4" />
    <path d="M10.5 18h3" {...g} />
  </>,
);
export const Monitor = icon(
  'Monitor',
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8.5 20h7M12 16v4" />
    <path d="M7 12.5h4" {...g} />
  </>,
);
export const Globe = icon(
  'Globe',
  <>
    {RING}
    <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5S9.6 5.9 12 3.5Z" />
  </>,
);
export const Languages = icon(
  'Languages',
  <>
    <path d="M4 5.5h8M8 4v1.5c0 3.5-1.8 6.5-4.5 8M5.5 9c1 2 2.7 3.6 4.8 4.5" />
    <path d="m12 20 3.8-9 3.8 9" />
    <path d="M13.3 17h5" {...g} />
  </>,
);
export const Settings = icon(
  'Settings',
  <>
    <path d="m12 2.8 1.6 2.3 2.7-.6.6 2.7 2.3 1.6-1.2 2.5 1.2 2.5-2.3 1.6-.6 2.7-2.7-.6-1.6 2.3-1.6-2.3-2.7.6-.6-2.7-2.3-1.6 1.2-2.5-1.2-2.5 2.3-1.6.6-2.7 2.7.6Z" />
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="12" r="1.1" {...gd} />
  </>,
);

export const Phone = icon(
  'Phone',
  <>
    <path d="M6.6 3.8h2.6l1.4 4-1.9 1.3a10.6 10.6 0 0 0 6.2 6.2l1.3-1.9 4 1.4v2.6a2 2 0 0 1-2.2 2A15.8 15.8 0 0 1 4.6 6a2 2 0 0 1 2-2.2Z" />
    <circle cx="17" cy="7" r="1.6" {...gd} />
  </>,
);
export const Store = icon(
  'Store',
  <>
    <path d="M4 9.5 5.5 4.5h13L20 9.5M4 9.5h16v1a2.7 2.7 0 0 1-5.3 0 2.7 2.7 0 0 1-5.4 0A2.7 2.7 0 0 1 4 10.5Z" />
    <path d="M5.5 13v7h13v-7" />
    <rect x="10" y="15.5" width="4" height="4.5" rx=".8" {...gd} />
  </>,
);
/* ---- the product's own subjects (no stock equivalent) ---------------------- */

/** An open খাতা: two columns, with the gold rule of a total under them. */
export const Ledger = icon(
  'Ledger',
  <>
    <path d="M5 4h12.5A1.5 1.5 0 0 1 19 5.5v15H6.5A1.5 1.5 0 0 1 5 19Z" />
    <path d="M12 4v16.5M7.5 8h2.5M14 8h2.5M7.5 11.5h2.5M14 11.5h2.5" />
    <rect x="7" y="15.4" width="10" height="2" rx="1" {...gd} />
  </>,
);
/** Money going one way and coming back the other — ধার-দেনা. */
export const Exchange = icon(
  'Exchange',
  <>
    <path d="M4 8.5h13M14 5.5l3 3-3 3M20 15.5H7M10 18.5l-3-3 3-3" />
    <circle cx="20.2" cy="8.5" r="1.5" {...gd} />
    <circle cx="3.8" cy="15.5" r="1.5" {...gd} />
  </>,
);
/** A savings jar with a coin in it. */
export const Jar = icon(
  'Jar',
  <>
    <path d="M8 6.5h8V8c2.2 1 3.5 2.9 3.5 5.2v4.3a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-4.3C4.5 10.9 5.8 9 8 8Z" />
    <rect x="7" y="3.3" width="10" height="3.2" rx="1.2" />
    <circle cx="12" cy="15" r="2.6" {...gd} />
  </>,
);
/** The letter অ on a tile — the interface is in Bangla. */
export const BanglaLetter = icon(
  'BanglaLetter',
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <text
      x="12"
      y="16.2"
      textAnchor="middle"
      fontSize="11"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
    >
      অ
    </text>
    <path d="M8 18.4h8" {...g} />
  </>,
);
/** A phone still working without a signal. */
export const PhoneOffline = icon(
  'PhoneOffline',
  <>
    <rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6" />
    <path d="M9.5 9.5c1.6-1.3 3.4-1.3 5 0M10.8 12c.8-.6 1.6-.6 2.4 0" />
    <path d="M10 18.1h4" {...g} />
  </>,
);

/* ---- everyday spending ---------------------------------------------------- */

export const House = icon(
  'House',
  <>
    <path d="M4 11 12 4.6 20 11v8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 19Z" />
    <path d="M10 20.6v-5h4v5" />
    <circle cx="12" cy="11" r="1.4" {...gd} />
  </>,
);
/** A pay envelope with a coin — salary, income. */
export const Payslip = icon(
  'Payslip',
  <>
    <rect x="3.5" y="6" width="17" height="12.5" rx="2" />
    <path d="m4 7 8 6 8-6" />
    <circle
      cx="18.6"
      cy="17.6"
      r="3.2"
      fill={GOLD}
      stroke="var(--hishab-surface)"
      strokeWidth={1.2}
    />
  </>,
);
export const ShoppingBag = icon(
  'ShoppingBag',
  <>
    <path d="M5.2 8.5h13.6l-1 10.4a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8Z" />
    <path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" />
    <path d="M9 13.2h6" {...g} />
  </>,
);
export const Rickshaw = icon(
  'Rickshaw',
  <>
    <circle cx="6.5" cy="17" r="3" />
    <circle cx="17.5" cy="17" r="3" />
    <path d="M6.5 17 10 10.5h5.5M9.6 17h4.9M15.5 10.5c0-3.1 1.7-5.2 4.6-5.7v5.7Z" />
    <circle cx="6.5" cy="17" r="1" {...gd} />
    <circle cx="17.5" cy="17" r="1" {...gd} />
  </>,
);
export const Bulb = icon(
  'Bulb',
  <>
    <path d="M9 17h6M10 20h4M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.8.6 1.3 1.5 1.3 2.6h4c0-1.1.5-2 1.3-2.6A5.5 5.5 0 0 0 12 3.5Z" />
    <circle cx="12" cy="9" r="1.4" {...gd} />
  </>,
);
export const Heart = icon(
  'Heart',
  <>
    <path d="M12 19.5s-7-4.3-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.2c0 5-7 9.3-7 9.3Z" />
    <circle cx="12" cy="12.5" r="1.4" {...gd} />
  </>,
);

/* Exported under the stock set's name. Declared as `InfinityIcon` because a
   module-level binding called `Infinity` would shadow the global. */
export { InfinityIcon as Infinity };
