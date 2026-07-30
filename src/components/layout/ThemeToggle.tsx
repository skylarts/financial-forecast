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
 * Top-left theme switch: flips between the default dark theme and ☀️ joy mode.
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
      className="flex items-center gap-1 rounded-full border border-border bg-panel px-2.5 py-1 text-sm transition-transform hover:scale-105 active:scale-95"
    >
      <span className="text-base leading-none">{isJoy ? "☀️" : "🖤"}</span>
      <span className="text-xs font-medium text-dim">{isJoy ? "Joy" : "Dark"}</span>
    </button>
  );
}
