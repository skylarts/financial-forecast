"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface Section {
  href: string;
  label: string;
  /** Drawn at the caller's pixel size, in whatever color the link already is. */
  icon: (props: { size: number }) => ReactNode;
  /** One line explaining what the section is for, shown on hover. */
  hint: string;
}

/**
 * Shared frame for the section icons. They're stroke art on a 24x24 grid
 * rather than text glyphs because neither shape exists as a character -- the
 * only compass in Unicode is the color emoji, which would ignore the rail's
 * state colors entirely, and nothing at all draws an arrow that dips partway
 * along. Stroking in `currentColor` keeps that inheritance: dim on the rail,
 * `pri-fg` on the active pill, `accent` in the tab bar, with no per-icon rules.
 */
function IconFrame({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

/** A compass, for the tool that plots where the household is headed. */
function CompassIcon({ size }: { size: number }) {
  return (
    <IconFrame size={size}>
      <circle cx="12" cy="12" r="9" />
      {/* Filled rather than outlined: at 15px an outlined needle's two edges
          sit close enough to close up into a smudge. */}
      <path d="M16.2 7.8 14.1 14.1 7.8 16.2 9.9 9.9Z" fill="currentColor" />
    </IconFrame>
  );
}

/**
 * A line that rises, gives some back, then rises further -- how a real
 * portfolio gets to the top right of the chart.
 */
function TrendIcon({ size }: { size: number }) {
  return (
    <IconFrame size={size}>
      <path d="M2 17 8.5 10.5 13.5 15.5 22 7" />
      <path d="M16 7h6v6" />
    </IconFrame>
  );
}

/**
 * The app's top-level sections. This is the list to extend when another tool
 * joins the forecast and the tracker -- nothing else needs to change.
 */
const SECTIONS: Section[] = [
  { href: "/", label: "Forecast", icon: CompassIcon, hint: "Household net-worth projection" },
  {
    href: "/portfolio",
    label: "Portfolio",
    icon: TrendIcon,
    hint: "Holdings, tax lots, and performance",
  },
];

const COLLAPSE_KEY = "sidenav-collapsed";

/**
 * The collapsed flag lives in localStorage, which React can't see. Exposing it
 * as an external store rather than copying it into state on mount means the
 * server render and the first client render agree (both "expanded"), and the
 * saved value takes over on hydration without an extra render pass.
 */
const collapseListeners = new Set<() => void>();

const collapseStore = {
  subscribe(listener: () => void) {
    collapseListeners.add(listener);
    return () => collapseListeners.delete(listener);
  },
  getSnapshot: () =>
    typeof window !== "undefined" && window.localStorage.getItem(COLLAPSE_KEY) === "true",
  /** The server has no storage, so it always renders the rail expanded. */
  getServerSnapshot: () => false,
  toggle() {
    const next = !collapseStore.getSnapshot();
    window.localStorage.setItem(COLLAPSE_KEY, String(next));
    for (const listener of collapseListeners) listener();
  },
};

function isActive(pathname: string, href: string): boolean {
  // "/" would otherwise prefix-match every route.
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * The desktop rail. Hidden below `md`, where a 176px column would eat half a
 * phone's width -- that layout hands its job to `MobileTabBar` instead.
 */
export function SideNav() {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(
    collapseStore.subscribe,
    collapseStore.getSnapshot,
    collapseStore.getServerSnapshot,
  );

  return (
    <nav
      aria-label="Sections"
      className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-panel-2 transition-[width] duration-150 md:flex ${
        collapsed ? "w-[56px]" : "w-[176px]"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-4">
        <span className="text-[15px] leading-none text-accent">❖</span>
        {!collapsed && (
          <span className="truncate text-[13px] font-semibold text-foreground">Money</span>
        )}
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 px-2">
        {SECTIONS.map((section) => {
          const active = isActive(pathname, section.href);
          const Icon = section.icon;
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                // Collapsed, the icon is the only thing left in the link, and
                // it's decorative -- name the link explicitly rather than
                // leaning on `title` to stand in for one.
                aria-label={collapsed ? section.label : undefined}
                title={collapsed ? `${section.label} — ${section.hint}` : section.hint}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors ${
                  active
                    ? "bg-pri font-semibold text-pri-fg"
                    : "text-dim hover:bg-panel-3 hover:text-foreground"
                } ${collapsed ? "justify-center" : ""}`}
              >
                <Icon size={15} />
                {!collapsed && <span className="truncate">{section.label}</span>}
              </Link>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={collapseStore.toggle}
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
        aria-expanded={!collapsed}
        className="m-2 rounded-md border border-border px-2 py-1.5 text-[12px] text-dim-2 transition-colors hover:border-accent hover:text-foreground"
      >
        {collapsed ? "»" : "« Collapse"}
      </button>
    </nav>
  );
}

/**
 * The phone equivalent of the rail: a fixed bottom bar, the convention every
 * mobile OS already trained people on. Bottom rather than top because it sits
 * in thumb reach, and because the top of these pages is already dense with the
 * scenario/scope controls.
 *
 * It's `fixed`, so it's out of flow -- `app-shell` in globals.css reserves the
 * matching bottom padding, including the home-indicator inset, so the last row
 * of a table is never trapped underneath it.
 */
export function MobileTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-panel-2 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {SECTIONS.map((section) => {
        const active = isActive(pathname, section.href);
        const Icon = section.icon;
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
              active ? "text-accent" : "text-dim"
            }`}
          >
            <Icon size={18} />
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
