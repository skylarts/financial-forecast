"use client";

import { useEffect } from "react";
import { useUiStore } from "@/store/useUiStore";

/**
 * Top-left theme switch: flips between the default dark theme and 🩷 pink mode.
 * Applies the choice by stamping data-theme on <html>, which the CSS variables
 * in globals.css key off, so the whole app re-skins at once.
 */
export function ThemeToggle() {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const isPink = theme === "pink";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-pressed={isPink}
      title={isPink ? "Switch to dark mode" : "Switch to pink mode 🩷"}
      className="flex items-center gap-1 rounded-full border border-border bg-panel px-2.5 py-1 text-sm transition-transform hover:scale-105 active:scale-95"
    >
      <span className="text-base leading-none">{isPink ? "🩷" : "🖤"}</span>
      <span className="text-xs font-medium text-dim">{isPink ? "Pink" : "Dark"}</span>
    </button>
  );
}
