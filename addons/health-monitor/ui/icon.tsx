/**
 * The module's icon, shown beside its name.
 *
 * An inline SVG rather than an image file: it ships inside the module, needs no upload
 * or serving route, and `currentColor` means it follows light and dark themes without
 * two versions. A heartbeat line — the shape people already read as "health".
 */
export function HealthIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12h4l2.5-7 4 14 3-9 2 2h4.5" />
    </svg>
  );
}
