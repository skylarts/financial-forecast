"use client";

/**
 * A marker's icon on the chart and the Timeline.
 *
 * Most are a single emoji, which renders at any size and needs no assets.
 * A handful of life events have no emoji that reads correctly at 22px --
 * refinancing, downsizing, going part-time, financing a car -- so those are
 * drawn here instead. Anything prefixed `art:` picks one of these.
 *
 * The drawings use `currentColor` throughout, so they inherit the marker's
 * tone (accent for events, green for income, red for expenses) and are
 * correct in both themes for free.
 */

const ART_PREFIX = "art:";

/** True when this icon string names a drawing rather than an emoji. */
export function isArtIcon(icon: string): boolean {
  return icon.startsWith(ART_PREFIX);
}

function Art({ name }: { name: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    width: "100%",
    height: "100%",
    "aria-hidden": true,
  };
  switch (name) {
    // A loan swapped for another: two arrows circling a percent sign.
    case "refinance":
      return (
        <svg {...common}>
          <path d="M4 9a8 8 0 0 1 13.5-4.2L20 7" />
          <path d="M20 3.5V7.5h-4" />
          <path d="M20 15a8 8 0 0 1-13.5 4.2L4 17" />
          <path d="M4 20.5V16.5h4" />
          <circle cx="10" cy="10.5" r="1.3" />
          <circle cx="14.6" cy="14.3" r="1.3" />
          <path d="M15.4 9.6 9.2 15.4" />
        </svg>
      );
    // Downsizing: a big roof next to a small one, with an arrow between.
    case "downsize":
      return (
        <svg {...common}>
          <path d="M2 11 7 6.5 12 11" />
          <path d="M3.6 10.2V19h6.8v-8.8" />
          <path d="M14.5 16 17.5 13.4 20.5 16" />
          <path d="M15.4 15.4V19h4.2v-3.6" />
          <path d="M12.4 7.5h3.9" />
          <path d="M14.8 5.9 16.6 7.5 14.8 9.1" />
        </svg>
      );
    // Going part-time: a clock with half its face filled.
    case "part_time":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.6" />
          <path d="M12 3.4a8.6 8.6 0 0 1 0 17.2Z" fill="currentColor" stroke="none" opacity="0.55" />
          <path d="M12 7.2V12l3 1.8" />
        </svg>
      );
    // A financed car: a car with a percent sign riding above it.
    case "car_loan":
      return (
        <svg {...common}>
          <path d="M2.6 17.2v-3.1l1.9-4.3h9.7l1.9 4.3v3.1" />
          <path d="M2.6 15.4h13.5" />
          <circle cx="5.9" cy="17.6" r="1.6" />
          <circle cx="12.8" cy="17.6" r="1.6" />
          <circle cx="18.6" cy="5.6" r="1.15" />
          <circle cx="22" cy="9.2" r="1.15" />
          <path d="M22.4 5.2 18.2 9.6" />
        </svg>
      );
    default:
      return null;
  }
}

/** Renders an icon string: an emoji as text, or one of the drawings above. */
export function MarkerIcon({ icon }: { icon: string }) {
  if (!isArtIcon(icon)) return <>{icon}</>;
  return (
    <span className="flex h-[72%] w-[72%] items-center justify-center">
      <Art name={icon.slice(ART_PREFIX.length)} />
    </span>
  );
}
