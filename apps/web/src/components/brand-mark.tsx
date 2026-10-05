/**
 * The product's mark: the ৳ on its tile inside the green square, and the name
 * beside it.
 *
 * It lived inline in the marketing header and was about to be typed a second
 * time on the shared statement — the one page people outside the product ever
 * see. Two copies of a logo drift, and the copy that drifts is the one a
 * creditor is holding.
 *
 * The paths are brand/takatracker-icon.svg, outlines and all, so the mark on
 * screen is the mark on the poster rather than a ৳ typed into a coloured box.
 * Its colours are the artwork's own, not theme tokens: a logo does not change
 * colour with the reader's palette.
 *
 * A server component with no state and no client bundle: it renders on the
 * marketing pages, on the statement, and in print, where a `use client` island
 * would be dead weight three times over.
 */

import { cn } from '@/lib/utils';

const SIZES = {
  sm: { box: 'h-8 w-8', word: 'text-base' },
  md: { box: 'h-10 w-10', word: 'text-lg' },
  lg: { box: 'h-12 w-12', word: 'text-xl' },
} as const;

export function LogoGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden focusable="false" className={className}>
      <path
        fill="#1F6F4A"
        d="M24 0h52c13.255 0 24 10.745 24 24v52c0 13.255-10.745 24-24 24H24C10.745 100 0 89.255 0 76V24C0 10.745 10.745 0 24 0Z"
      />
      <path
        fill="#FFFFFF"
        d="M32 18h36c7.732 0 14 6.268 14 14v36c0 7.732-6.268 14-14 14H32c-7.732 0-14-6.268-14-14V32c0-7.732 6.268-14 14-14Z"
      />
      <path
        fill="#16241D"
        d="M50.5556 57 Q46.2623 57 43.836 55.0814 Q41.4097 53.1629 41.4097 49.1641 L41.4097 35.2172 L46.5668 35.2172 L46.5668 49.0904 Q46.5668 51.0887 47.6225 51.975 Q48.6782 52.8612 50.5687 52.8612 Q51.8535 52.8612 52.7832 52.3946 Q53.7128 51.928 54.3494 51.1947 Q54.7095 50.7772 54.9493 50.309 Q55.189 49.8408 55.315 49.3554 Q55.441 48.87 55.441 48.4362 Q55.441 47.4491 54.7953 46.9447 Q54.1495 46.4404 52.6598 46.4404 Q51.9251 46.4404 51.17 46.4895 Q50.4149 46.5386 49.6294 46.6073 L49.9417 42.6319 Q50.7629 42.5763 51.5358 42.5378 Q52.3086 42.4994 53.205 42.4994 Q56.8067 42.4994 58.6264 43.9053 Q60.4461 45.3111 60.4461 48.103 Q60.4461 48.887 60.2791 49.7403 Q60.1122 50.5936 59.7743 51.4451 Q59.4363 52.2966 58.8898 53.0753 Q57.6974 54.8511 55.5976 55.9255 Q53.4977 57 50.5556 57 Z M38.3517 39.1369 38.077 35.191 L61.8231 35.191 L62.1272 39.1369 Z M41.3885 35.5578 L41.3885 33.2689 Q41.3885 32.2474 40.908 31.6754 Q40.4276 31.1033 39.3803 31.1033 L38.1638 31.1033 L37.8728 27 L39.359 27 Q42.8778 27 44.7223 28.49 Q46.5668 29.9801 46.5668 33.2689 L46.5668 35.5578 Z"
      />
      <path
        fill="#C8892C"
        d="M38.2 63h23.6c.939 0 1.7.761 1.7 1.7s-.761 1.7-1.7 1.7H38.2c-.939 0-1.7-.761-1.7-1.7s.761-1.7 1.7-1.7Z"
      />
    </svg>
  );
}

export function BrandMark({
  size = 'sm',
  /** The mark alone, for places that already say the name. */
  wordmark = true,
  className = '',
}: {
  size?: keyof typeof SIZES;
  wordmark?: boolean;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <LogoGlyph className={`shrink-0 ${s.box}`} />
      {wordmark ? (
        <span
          className={`text-ink font-wordmark whitespace-nowrap font-bold tracking-[0.01em] ${s.word}`}
        >
          Taka Tracker
        </span>
      ) : null}
    </span>
  );
}
