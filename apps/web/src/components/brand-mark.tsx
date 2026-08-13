/**
 * The product's mark: a taka sign in a brand square, and the name beside it.
 *
 * It lived inline in the marketing header and was about to be typed a second
 * time on the shared statement — the one page people outside the product ever
 * see. Two copies of a logo drift, and the copy that drifts is the one a
 * creditor is holding.
 *
 * A server component with no state and no client bundle: it renders on the
 * marketing pages, on the statement, and in print, where a `use client` island
 * would be dead weight three times over.
 */

const SIZES = {
  sm: { box: 'h-7 w-7 rounded-md text-sm', word: 'text-base' },
  md: { box: 'h-9 w-9 rounded-lg text-lg', word: 'text-lg' },
  lg: { box: 'h-11 w-11 rounded-lg text-xl', word: 'text-xl' },
} as const;

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
    <span className={`flex items-center gap-2 font-semibold ${className}`}>
      <span
        aria-hidden
        /* `print:border` because the print stylesheet flattens every background
           to white — without a rule the square disappears and the letterhead
           becomes a bare ৳ floating above the page. */
        className={`bg-brand text-brand-contrast flex shrink-0 items-center justify-center font-bold print:border print:border-black ${s.box}`}
      >
        ৳
      </span>
      {wordmark ? <span className={`text-ink ${s.word}`}>Taka Tracker</span> : null}
    </span>
  );
}
