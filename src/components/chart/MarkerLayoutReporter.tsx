"use client";

import { useEffect } from "react";
import { usePlotArea, useXAxisScale } from "recharts";

export interface MarkerLayout {
  /** Pixel x-position of each visible year, relative to the chart container. */
  xByYear: Map<number, number>;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Renders nothing -- it must be a child of a recharts chart to read the
 * computed x-axis scale and plot area via hooks, then reports pixel
 * positions up to NetWorthChart (which lives outside the chart's context
 * and renders the actual marker overlay as plain HTML on top of the SVG).
 */
export function MarkerLayoutReporter({
  years,
  onLayout,
}: {
  years: number[];
  onLayout: (layout: MarkerLayout | null) => void;
}) {
  const scale = useXAxisScale();
  const plotArea = usePlotArea();

  useEffect(() => {
    if (!scale || !plotArea) {
      onLayout(null);
      return;
    }
    const xByYear = new Map<number, number>();
    for (const year of years) {
      const x = scale(year);
      if (typeof x === "number") xByYear.set(year, x);
    }
    onLayout({
      xByYear,
      top: plotArea.y,
      bottom: plotArea.y + plotArea.height,
      left: plotArea.x,
      right: plotArea.x + plotArea.width,
    });
    // years is a plain array of numbers rebuilt each render; comparing by
    // value (join) avoids re-reporting (and the setState loop that would
    // follow) when the same years are still visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, plotArea, years.join(",")]);

  return null;
}
