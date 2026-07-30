"use client";

import { useEffect } from "react";
import { useUiStore } from "@/store/useUiStore";

/**
 * Keeps <html data-theme> in sync with the store, independent of whether any
 * particular toggle UI is mounted.
 *
 * This used to be a useEffect inside ThemeToggle itself, which was safe back
 * when ThemeToggle was always rendered in the header. Once the toggle moved
 * into the (collapsed-by-default) overflow menu, that effect stopped running
 * until a user opened the menu at least once -- so a saved Joy-mode plan
 * would load with the header already reading "Forecast ✨ Bright days ahead"
 * while every token on the page was still rendering in dark. Mount this once,
 * unconditionally, near the app root.
 */
export function ThemeSync() {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return null;
}

/**
 * Theme switch row for the overflow menu: flips between the default dark
 * theme and ☀️ joy mode.
 */
export function ThemeToggle() {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  const isJoy = theme === "joy";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-pressed={isJoy}
      title={isJoy ? "Switch to dark mode" : "Switch to joy mode ☀️"}
      className="flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm text-dim hover:bg-background/40 hover:text-foreground"
    >
      <span>Theme</span>
      <span className="flex items-center gap-1 text-xs font-medium">
        <span className="text-base leading-none">{isJoy ? "☀️" : "🖤"}</span>
        {isJoy ? "Joy" : "Dark"}
      </span>
    </button>
  );
}
