/**
 * The pure parts of the timeline's drag and drop (INS-03, components/planning/use-trip-drag.ts):
 * when a press becomes a drag, how fast the box scrolls near its edges, which row an element
 * belongs to. Pure module.
 */

/** A press that moves less than this (px) stays a click: it selects the trip. */
export const DRAG_THRESHOLD_PX = 6;

/** Within this distance (px) of the box's top or bottom edge, the box scrolls. */
export const AUTO_SCROLL_EDGE_PX = 56;

/** Fastest scroll, at the very edge (px per frame). */
export const AUTO_SCROLL_MAX_PX = 18;

/**
 * Pixels to scroll the box by this frame for a pointer at `y` (viewport coordinates) in a box from
 * `top` to `bottom`: negative near the top, positive near the bottom, faster closer to the edge, 0
 * elsewhere. The top band starts below the pinned axis and « À placer » row (`pinnedPx`): over them
 * nothing scrolls (« À placer » is a drop zone, the rows must stay still under it).
 */
export function autoScrollStep(y: number, top: number, bottom: number, pinnedPx = 0): number {
  const upper = top + pinnedPx;
  if (y < upper + AUTO_SCROLL_EDGE_PX && y >= upper) {
    const depth = Math.min(1, (upper + AUTO_SCROLL_EDGE_PX - y) / AUTO_SCROLL_EDGE_PX);
    return -Math.ceil(depth * AUTO_SCROLL_MAX_PX);
  }
  if (y > bottom - AUTO_SCROLL_EDGE_PX && y <= bottom) {
    const depth = Math.min(1, (y - (bottom - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX);
    return Math.ceil(depth * AUTO_SCROLL_MAX_PX);
  }
  return 0;
}

type RowElement = { closest: (selector: string) => { getAttribute: (name: string) => string | null; hasAttribute?: (name: string) => boolean } | null };

/**
 * The drop row of an element of the timeline: the vehicle id of its row, `unassignedRowId` for the
 * « À placer » row, undefined elsewhere (axis, depot header, outside the timeline).
 */
export function dropRowIdOf(element: RowElement | null, unassignedRowId: string): string | undefined {
  if (!element || typeof element.closest !== "function") return undefined;
  if (element.closest("[data-pinned-row]")) return unassignedRowId;
  const row = element.closest("[data-vehicle-id]");
  return row?.getAttribute("data-vehicle-id") ?? undefined;
}
