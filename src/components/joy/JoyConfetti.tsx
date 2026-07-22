"use client";

import { useEffect, useRef, useState } from "react";

const COLORS = ["#ff7a59", "#ffb14e", "#2fb98d", "#3ec7cf", "#ffd166", "#f4a63b", "#ff9d6f"];

interface Piece {
  id: number;
  left: number;
  delay: number;
  duration: number;
  color: string;
  rotate: number;
  width: number;
  height: number;
}

const SESSION_KEY = "joy-confetti-fired";

/**
 * A dependency-free confetti burst. Fires on the rising edge of `fire` -- i.e.
 * when you switch *into* joy mode with a plan that reaches retirement -- but at
 * most ONCE per browser session, so it celebrates without replaying on every
 * page load and covering the chart each visit. (Toggling joy off and on again
 * within a session stays quiet; a fresh session celebrates again.)
 */
export function JoyConfetti({ fire }: { fire: boolean }) {
  const [pieces, setPieces] = useState<Piece[] | null>(null);
  const wasFiring = useRef(false);

  useEffect(() => {
    const risingEdge = fire && !wasFiring.current;
    wasFiring.current = fire;
    if (!risingEdge) return;
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      // sessionStorage unavailable (private mode edge cases) -- fire anyway.
    }

    const items: Piece[] = Array.from({ length: 90 }).map((_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.8,
      duration: 3.2 + Math.random() * 2.2,
      color: COLORS[i % COLORS.length],
      rotate: Math.random() * 360,
      width: 7 + Math.random() * 7,
      height: 9 + Math.random() * 9,
    }));
    setPieces(items);
    const t = setTimeout(() => setPieces(null), 7000);
    return () => clearTimeout(t);
  }, [fire]);

  if (!pieces) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden>
      {pieces.map((p) => (
        <span
          key={p.id}
          className="joy-confetti-piece"
          style={{
            left: `${p.left}%`,
            width: p.width,
            height: p.height,
            background: p.color,
            transform: `rotate(${p.rotate}deg)`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
          }}
        />
      ))}
    </div>
  );
}
