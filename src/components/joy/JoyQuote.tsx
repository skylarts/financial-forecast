"use client";

import { useEffect, useState } from "react";

// Warm, encouraging, money-positive one-liners. Kept upbeat and human -- the
// goal is a gentle smile, not a lecture.
const QUOTES = [
  "A little saved today blooms into freedom tomorrow. 🌷",
  "You're not just budgeting — you're building a life you love. ✨",
  "Every dollar you save is a vote for your future self. 💛",
  "Small steps, big dreams. You've got this. ☀️",
  "Your future self is already cheering you on. 🌻",
  "Money grows best when it's planted with intention. 🌱",
  "Progress, not perfection — you're doing beautifully. 🌸",
  "Confidence with money is a superpower, and it's yours. 💫",
];

/**
 * A softly-rotating inspirational line, shown only in joy mode. Picks a random
 * starting quote on mount (so it varies per visit) and gently cross-fades to a
 * new one every 12s. Random selection happens in an effect to avoid an SSR
 * hydration mismatch.
 */
export function JoyQuote() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setIndex(Math.floor(Math.random() * QUOTES.length));
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      // fade out, swap, fade back in
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % QUOTES.length);
        setVisible(true);
      }, 400);
    }, 12000);
    return () => clearInterval(interval);
  }, []);

  return (
    <p
      className="text-center text-sm italic text-dim"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 400ms ease" }}
    >
      {QUOTES[index]}
    </p>
  );
}
