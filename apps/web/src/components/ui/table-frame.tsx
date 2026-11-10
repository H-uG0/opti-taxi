"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";

/** How close to the top of the screen (under the demo banner) the frame counts as reached, in px. */
const DOCK_MARGIN = 16;

/**
 * Frame of a table with pinned column headers: never taller than the screen,
 * it scrolls inside once its top has reached the top of the screen. Before
 * that the page scrolls (the wheel over the list moves the page, not the
 * frame), so the bottom of the frame and its horizontal scrollbar come into
 * view instead of staying under the fold while the list scrolls.
 */
export function StickyHeaderFrame({ className, children }: { className?: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const banner = Number.parseFloat(getComputedStyle(element).getPropertyValue("--demo-banner-h")) || 0;
      // + 1: a fractional position at the very end of the page still counts.
      setDocked(element.getBoundingClientRect().top <= banner + DOCK_MARGIN + 1);
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <div ref={frame} data-docked={docked ? "" : undefined} className={cn(className, docked ? "overflow-y-auto" : "overflow-y-hidden")}>
      {children}
    </div>
  );
}
