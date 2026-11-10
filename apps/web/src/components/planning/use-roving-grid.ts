"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/** A row of the grid the arrow keys walk through (depot header, « À placer », vehicle). */
export const ROVING_ROW = "data-roving-row";
/** The item that takes the Tab stop when none was used yet: the selected trip, else the selected vehicle. */
export const ROVING_PREFERRED = "data-roving-preferred";
/**
 * The only item of its row ↑ ↓ land on (a depot's fold toggle: never its bulk « Figer », « Défiger », which ← →
 * reach from it); while it is disabled, ↑ ↓ pass the row by.
 */
export const ROVING_ANCHOR = "data-roving-anchor";

const ROW_SELECTOR = `[${ROVING_ROW}]`;
const PAGE_ROWS = 10;

const enabled = (el: HTMLElement) => !el.hasAttribute("disabled");

function buttonsOf(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button"));
}

function itemsOf(root: ParentNode): HTMLElement[] {
  return buttonsOf(root).filter(enabled);
}

function centerX(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  return rect.left + rect.width / 2;
}

/** The item of `items` horizontally closest to `x` (the same time on the next vehicle), `x` in the grid's coordinates. */
function closestTo(items: HTMLElement[], x: number, gridLeft: number): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let distance = Infinity;
  for (const item of items) {
    const d = Math.abs(centerX(item) - gridLeft - x);
    if (d < distance) {
      best = item;
      distance = d;
    }
  }
  return best;
}

/**
 * Roving tabindex over the timeline (UX-08): the whole grid is one Tab stop;
 * ↑ ↓ move between rows (to the item at the same time, kept across a depot's
 * header, where they land on its fold toggle), ← → between the items of a row
 * (vehicle, then its trips in time order), Début / Fin to the ends of the row,
 * Page préc. / Page suiv. ten rows away. Items are the enabled buttons of the
 * rows marked with `data-roving-row`; the tabindex of every button of these
 * rows is kept by this hook (-1 for all but the active one), whoever rendered
 * them and whenever they are enabled or disabled.
 */
export function useRovingGrid(
  gridRef: RefObject<HTMLElement | null>,
  { selectionKey, reveal }: { selectionKey: string; reveal: (item: HTMLElement) => void },
): { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void; onFocus: (e: FocusEvent<HTMLElement>) => void } {
  const active = useRef<HTMLElement | null>(null);
  /** Where ↑ ↓ aim (grid coordinates), kept from the last item reached otherwise: a header row does not lose the time. */
  const aimX = useRef<number | null>(null);
  /** The focus is being moved by the arrows (not a click nor a Tab). */
  const moving = useRef(false);

  const sync = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const buttons = Array.from(grid.querySelectorAll<HTMLElement>(ROW_SELECTOR)).flatMap((row) => buttonsOf(row));
    const items = buttons.filter(enabled);
    let current = active.current;
    if (!current || !items.includes(current)) {
      const preferred = grid.querySelector<HTMLElement>(`[${ROVING_PREFERRED}]`);
      current = preferred && items.includes(preferred) ? preferred : (items[0] ?? null);
    }
    active.current = current;
    // Disabled buttons too: one enabled later (by a component re-rendering alone) is never an extra Tab stop.
    for (const button of buttons) {
      const value = button === current ? "0" : "-1";
      if (button.getAttribute("tabindex") !== value) button.setAttribute("tabindex", value);
    }
  }, [gridRef]);

  // After every render (rows added, filtered, folded), when buttons appear inside the rows (a depot's « Défiger »
  // confirmation, by another component) or get enabled or disabled: exactly one item stays in the Tab order.
  useLayoutEffect(() => sync());
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => sync());
    observer.observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
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
      moving.current = true;
      try {
        next.focus({ preventScroll: true });
      } finally {
        moving.current = false;
      }
      reveal(next);
    },
    [reveal],
  );

  const onFocus = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== "BUTTON" || !target.closest(ROW_SELECTOR)) return;
      // Reached by a click or a Tab: ↑ ↓ aim at this item from now on.
      if (!moving.current) aimX.current = null;
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
      const gridLeft = grid.getBoundingClientRect().left;
      const x = aimX.current ?? centerX(target) - gridLeft;
      /** Where ↑ ↓ land in a row: its anchor, else the item closest to the time aimed at; null: pass the row by. */
      const landing = (candidate: HTMLElement): HTMLElement | null => {
        const anchor = candidate.querySelector<HTMLElement>(`[${ROVING_ANCHOR}]`);
        if (anchor) return enabled(anchor) ? anchor : null;
        return closestTo(itemsOf(candidate), x, gridLeft) ?? null;
      };
      /** The landing item of the first row that has one from `start`, going `step` (±1). */
      const inRow = (start: number, step: number): HTMLElement | undefined => {
        for (let i = start; i >= 0 && i < rows.length; i += step) {
          const item = landing(rows[i]!);
          if (item) return item;
        }
        return undefined;
      };
      let next: HTMLElement | undefined;
      let vertical = false;
      switch (e.key) {
        case "ArrowRight":
          next = items[index + 1];
          break;
        case "ArrowLeft":
          next = index > 0 ? items[index - 1] : undefined;
          break;
        case "Home":
          vertical = e.ctrlKey;
          next = e.ctrlKey ? inRow(0, 1) : items[0];
          break;
        case "End":
          vertical = e.ctrlKey;
          next = e.ctrlKey ? inRow(rows.length - 1, -1) : items.at(-1);
          break;
        case "ArrowDown":
          vertical = true;
          next = inRow(rowIndex + 1, 1);
          break;
        case "ArrowUp":
          vertical = true;
          next = inRow(rowIndex - 1, -1);
          break;
        case "PageDown":
          vertical = true;
          next = inRow(Math.min(rows.length - 1, rowIndex + PAGE_ROWS), 1) ?? inRow(rows.length - 1, -1);
          break;
        case "PageUp":
          vertical = true;
          next = inRow(Math.max(0, rowIndex - PAGE_ROWS), -1) ?? inRow(0, 1);
          break;
        default:
          return;
      }
      // At an edge the key does nothing, and never scrolls the box behind.
      e.preventDefault();
      if (!next || next === target) return;
      // ↑ ↓ keep aiming at the same time; ← → and Début / Fin aim at the item they reach.
      aimX.current = vertical ? x : null;
      move(next);
    },
    [gridRef, move],
  );

  return { onKeyDown, onFocus };
}
