"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/** A row of the grid the arrow keys walk through (depot header, « À placer », vehicle). */
export const ROVING_ROW = "data-roving-row";
/** The item that takes the Tab stop when none was used yet: the selected trip, else the selected vehicle. */
export const ROVING_PREFERRED = "data-roving-preferred";

const ROW_SELECTOR = `[${ROVING_ROW}]`;
const PAGE_ROWS = 10;

function itemsOf(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button")).filter((el) => !el.hasAttribute("disabled"));
}

function centerX(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  return rect.left + rect.width / 2;
}

/** The item of `items` horizontally closest to `x` (the same time on the next vehicle). */
function closestTo(items: HTMLElement[], x: number): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let distance = Infinity;
  for (const item of items) {
    const d = Math.abs(centerX(item) - x);
    if (d < distance) {
      best = item;
      distance = d;
    }
  }
  return best;
}

/**
 * Roving tabindex over the timeline (UX-08): the whole grid is one Tab stop;
 * ↑ ↓ move between rows (to the item at the same time), ← → between the items
 * of a row (vehicle, then its trips in time order), Début / Fin to the ends of
 * the row, Page préc. / Page suiv. ten rows away. Items are the enabled
 * buttons of the rows marked with `data-roving-row`; their tabindex is kept by
 * this hook (-1 for all but the active one), whoever rendered them.
 */
export function useRovingGrid(
  gridRef: RefObject<HTMLElement | null>,
  { selectionKey, reveal }: { selectionKey: string; reveal: (item: HTMLElement) => void },
): { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void; onFocus: (e: FocusEvent<HTMLElement>) => void } {
  const active = useRef<HTMLElement | null>(null);

  const allItems = useCallback((): HTMLElement[] => {
    const grid = gridRef.current;
    if (!grid) return [];
    return Array.from(grid.querySelectorAll<HTMLElement>(ROW_SELECTOR)).flatMap((row) => itemsOf(row));
  }, [gridRef]);

  const sync = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const items = allItems();
    let current = active.current;
    if (!current || !items.includes(current)) {
      const preferred = grid.querySelector<HTMLElement>(`[${ROVING_PREFERRED}]`);
      current = preferred && items.includes(preferred) ? preferred : (items[0] ?? null);
    }
    active.current = current;
    for (const item of items) {
      const value = item === current ? "0" : "-1";
      if (item.getAttribute("tabindex") !== value) item.setAttribute("tabindex", value);
    }
  }, [gridRef, allItems]);

  // After every render (rows added, filtered, folded), and when buttons appear inside the rows (a depot's
  // « Défiger » confirmation, by another component): exactly one item stays in the Tab order.
  useLayoutEffect(() => sync());
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => sync());
    observer.observe(grid, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [gridRef, sync]);

  // A selection made elsewhere (search, map, « À traiter ») becomes the Tab stop, unless the focus is in the grid.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid && !grid.contains(document.activeElement)) active.current = null;
    sync();
  }, [selectionKey, gridRef, sync]);

  const move = useCallback(
    (next: HTMLElement) => {
      const previous = active.current;
      if (previous && previous !== next) previous.setAttribute("tabindex", "-1");
      next.setAttribute("tabindex", "0");
      active.current = next;
      next.focus({ preventScroll: true });
      reveal(next);
    },
    [reveal],
  );

  const onFocus = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== "BUTTON" || !target.closest(ROW_SELECTOR)) return;
      if (active.current !== target) {
        active.current?.setAttribute("tabindex", "-1");
        target.setAttribute("tabindex", "0");
        active.current = target;
      }
      reveal(target);
    },
    [reveal],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement;
      const row = target.tagName === "BUTTON" ? target.closest<HTMLElement>(ROW_SELECTOR) : null;
      const grid = gridRef.current;
      if (!row || !grid) return;
      const rows = Array.from(grid.querySelectorAll<HTMLElement>(ROW_SELECTOR));
      const rowIndex = rows.indexOf(row);
      const items = itemsOf(row);
      const index = items.indexOf(target);
      const x = centerX(target);
      /** The closest item of the first row with items from `start`, going `step` (±1). */
      const inRow = (start: number, step: number): HTMLElement | undefined => {
        for (let i = start; i >= 0 && i < rows.length; i += step) {
          const candidates = itemsOf(rows[i]!);
          if (candidates.length > 0) return closestTo(candidates, x);
        }
        return undefined;
      };
      let next: HTMLElement | undefined;
      switch (e.key) {
        case "ArrowRight":
          next = items[index + 1];
          break;
        case "ArrowLeft":
          next = index > 0 ? items[index - 1] : undefined;
          break;
        case "Home":
          next = e.ctrlKey ? inRow(0, 1) : items[0];
          break;
        case "End":
          next = e.ctrlKey ? inRow(rows.length - 1, -1) : items.at(-1);
          break;
        case "ArrowDown":
          next = inRow(rowIndex + 1, 1);
          break;
        case "ArrowUp":
          next = inRow(rowIndex - 1, -1);
          break;
        case "PageDown":
          next = inRow(Math.min(rows.length - 1, rowIndex + PAGE_ROWS), 1) ?? inRow(rows.length - 1, -1);
          break;
        case "PageUp":
          next = inRow(Math.max(0, rowIndex - PAGE_ROWS), -1) ?? inRow(0, 1);
          break;
        default:
          return;
      }
      // At an edge the key does nothing, and never scrolls the box behind.
      e.preventDefault();
      if (next && next !== target) move(next);
    },
    [gridRef, move],
  );

  return { onKeyDown, onFocus };
}
