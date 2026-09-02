"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
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
 * along. Stroking in `currentColor` keeps that inheritance: dim in the drawer,
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

/**
 * Whether the drawer is showing. It lives outside React because its two ends
 * are far apart in the tree -- the button is inside each tool's own header,
 * the drawer is a sibling of the entire page in the root layout -- and a
 * provider spanning them would buy nothing over a module-level flag.
 *
 * It deliberately does not persist. The drawer is a momentary menu, not a
 * layout preference; one left open yesterday should not be covering the page
 * today.
 */
const openListeners = new Set<() => void>();
let navOpen = false;

const navStore = {
  subscribe(listener: () => void) {
    openListeners.add(listener);
    return () => openListeners.delete(listener);
  },
  getSnapshot: () => navOpen,
  /** The server has no drawer state, so it always renders it closed. */
  getServerSnapshot: () => false,
  set(next: boolean) {
    if (navOpen === next) return;
    navOpen = next;
    for (const listener of openListeners) listener();
  },
  toggle() {
    navStore.set(!navOpen);
  },
};

function useNavOpen(): boolean {
  return useSyncExternalStore(navStore.subscribe, navStore.getSnapshot, navStore.getServerSnapshot);
}

function isActive(pathname: string, href: string): boolean {
  // "/" would otherwise prefix-match every route.
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * The button each tool wraps around its own name in the top-left corner. With
 * the rail hidden, that name is the only thing up there, so it has to carry
 * the news that a menu is behind it: the three-line mark every other app uses
 * for exactly this, a box that separates it from the plain heading it used to
 * be, and a chevron that flips over while the drawer is open.
 *
 * The tool's name stays the label rather than being replaced by a generic
 * "Menu" -- it is still the answer to "where am I?", and trading that for a
 * verb would buy an affordance the mark and the chevron already provide.
 */
export function NavMenuButton({ children }: { children: ReactNode }) {
  const open = useNavOpen();

  return (
    <button
      type="button"
      onClick={navStore.toggle}
      aria-expanded={open}
      aria-haspopup="menu"
      title="Switch tools"
      className={`group -ml-1 flex items-center gap-2 rounded-md border px-2 py-1 text-foreground transition-colors ${
        open ? "border-accent bg-panel-2" : "border-border bg-panel-2/50 hover:border-accent hover:bg-panel-2"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        aria-hidden
        focusable="false"
        className="shrink-0 text-accent"
      >
        <path d="M3 6h18M3 12h18M3 18h18" />
      </svg>
      {children}
      <span
        aria-hidden
        className={`text-[10px] leading-none text-dim transition-transform group-hover:text-foreground ${
          open ? "rotate-180" : ""
        }`}
      >
        ▾
      </span>
    </button>
  );
}

/**
 * The section rail, now a drawer rather than a standing column: it slides in
 * over the page when the name in the top-left is clicked and gets out of the
 * way again as soon as a tool is picked. With two sections, a permanent 176px
 * column had little to do all day except take the width.
 *
 * Being `fixed`, it never occupies layout space -- the page underneath keeps
 * the whole window at every width, open or closed.
 */
export function SideNav() {
  const pathname = usePathname();
  const open = useNavOpen();
  const panelRef = useRef<HTMLElement>(null);

  // Any navigation ends the drawer's job, whether it came from a link in here
  // or from the back button.
  useEffect(() => {
    navStore.set(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") navStore.set(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Opening should also move the keyboard into the drawer; otherwise Tab from
  // the header walks the page behind it instead.
  useEffect(() => {
    if (open) panelRef.current?.querySelector("a")?.focus();
  }, [open]);

  return (
    <>
      {/* Mounted only while open, so it can't swallow clicks the rest of the
          time. A click anywhere off the drawer closes it, which is the gesture
          people already expect from a menu that covers the page. */}
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => navStore.set(false)}
          className="fixed inset-0 z-40 cursor-default bg-black/40"
        />
      )}

      <nav
        ref={panelRef}
        aria-label="Sections"
        // Kept mounted so the slide has something to animate, but out of the
        // tab order and the accessibility tree while it sits off-screen.
        inert={!open}
        className={`fixed inset-y-0 left-0 z-50 flex w-[210px] flex-col border-r border-border bg-panel-2 shadow-xl transition-transform duration-150 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex justify-end px-2 py-2">
          <button
            type="button"
            onClick={() => navStore.set(false)}
            aria-label="Close navigation"
            className="rounded-md px-2 py-1 text-[13px] text-dim-2 transition-colors hover:bg-panel-3 hover:text-foreground"
          >
            ✕
          </button>
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
                  title={section.hint}
                  onClick={() => navStore.set(false)}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors ${
                    active
                      ? "bg-pri font-semibold text-pri-fg"
                      : "text-dim hover:bg-panel-3 hover:text-foreground"
                  }`}
                >
                  <Icon size={15} />
                  <span className="truncate">{section.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

/**
 * The phone equivalent: a fixed bottom bar, the convention every mobile OS
 * already trained people on. It stays even though the drawer now works at
 * every width -- one thumb-reach tap beats reaching for the far top corner,
 * and on a phone the bar costs space the drawer would have covered anyway.
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
