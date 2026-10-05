'use client';

/**
 * The only client component on the shared statement.
 *
 * Everything else there is server-rendered HTML, which a reader with scripting
 * off can still print from their browser's own menu — this is the convenience
 * of not having to find it. `print:hidden` because a button on paper is
 * furniture.
 */
export function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="press border-rule text-ink hover:bg-greenbar mt-2 min-h-11 rounded-xl border px-3 text-sm print:hidden"
    >
      {label}
    </button>
  );
}
