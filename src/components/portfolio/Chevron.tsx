/**
 * The disclosure triangle on anything that folds: a section, an allocation
 * slice, a group of rows.
 *
 * Drawn rather than typed. `▶` is one of the characters iOS decides is an
 * emoji whether or not it is used as one, so on a phone every one of these
 * came out as a blue rounded square roughly the size of a checkbox -- next to
 * an actual column of checkboxes, in the transactions table. The glyph also
 * sat a shade off the text baseline on every platform, since it is drawn to
 * the em box rather than to the x-height.
 */
export function Chevron({ open, className = "h-2.5 w-2.5" }: { open: boolean; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      fill="currentColor"
      className={`${className} shrink-0 text-dim-2 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M4 2.5 8.5 6 4 9.5Z" />
    </svg>
  );
}
