"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { autoScrollStep, DRAG_THRESHOLD_PX, dropRowIdOf } from "@/lib/planning/drag";

/** What the board lets the timeline do with a trip (INS-03): drag it, and where it may go. */
export type TripDragApi = {
  /** Whether the trip may be dragged now (not cancelled or under way, nothing being checked…). */
  canDrag: (tripId: string) => boolean;
  /** Why the trip cannot be dropped on the vehicle's row, or on « À placer » (null), or null when it can. */
  dropIssue: (tripId: string, vehicleId: string | null) => string | null;
  onDrop: (tripId: string, vehicleId: string | null) => void;
};

/** The row the dragged trip is over: a vehicle's, or « À placer » (`unassignedRowId`), and why it cannot go there. */
export type DropTarget = { rowId: string; issue: string | null };

export type DragState = { tripId: string; fromRowId: string; x: number; y: number; target: DropTarget | null; keyboard: boolean };

const SINGLE_TRIP = /^\S+$/;

/**
 * Drag and drop of a trip on the timeline, written by hand on pointer events (no library): a press
 * on a trip that moves more than DRAG_THRESHOLD_PX starts the drag (a click still selects), the row
 * under the pointer is the target (the box scrolls near its top and bottom edges), the release
 * drops, Échap cancels. A touch press is left alone (it scrolls the box). The keyboard does the
 * same from a trip of the timeline: « M », then ↑ ↓ to choose the row, Entrée to drop, Échap to
 * cancel; each row is said with whether the trip can go there.
 */
export function useTripDrag({
  api,
  scrollerRef,
  gridRef,
  unassignedRowId,
  rowLabel,
  tripName,
  reveal,
}: {
  api: TripDragApi | undefined;
  scrollerRef: RefObject<HTMLElement | null>;
  gridRef: RefObject<HTMLElement | null>;
  unassignedRowId: string;
  rowLabel: (rowId: string) => string;
  tripName: (tripId: string) => string;
  reveal: (element: HTMLElement) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announce, setAnnounce] = useState("");
  const dragRef = useRef<DragState | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const endGesture = useRef<(() => void) | null>(null);
  const tickRef = useRef<() => void>(() => {});
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const update = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const targetOf = useCallback(
    (tripId: string, fromRowId: string, rowId: string | null): DropTarget | null => {
      const current = apiRef.current;
      if (!current || rowId === null || rowId === fromRowId) return null;
      return { rowId, issue: current.dropIssue(tripId, rowId === unassignedRowId ? null : rowId) };
    },
    [unassignedRowId],
  );

  const hitTest = useCallback(
    (x: number, y: number): string | null => {
      for (const element of document.elementsFromPoint(x, y)) {
        const rowId = dropRowIdOf(element as HTMLElement, unassignedRowId);
        if (rowId !== undefined) return rowId;
      }
      return null;
    },
    [unassignedRowId],
  );

  const stop = useCallback(() => {
    pointer.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    document.documentElement.style.removeProperty("cursor");
    document.documentElement.style.removeProperty("user-select");
    update(null);
  }, [update]);

  // The box scrolls while the pointer stays near its top or bottom edge: rows hidden below can be reached.
  const tick = useCallback(() => {
    frame.current = null;
    const state = dragRef.current;
    const at = pointer.current;
    const box = scrollerRef.current;
    if (!state || state.keyboard || !at || !box) return;
    const rect = box.getBoundingClientRect();
    const step = autoScrollStep(at.y, rect.top, rect.bottom);
    if (step === 0) return;
    box.scrollTop += step;
    update({ ...state, target: targetOf(state.tripId, state.fromRowId, hitTest(at.x, at.y)) });
    frame.current = requestAnimationFrame(() => tickRef.current());
  }, [scrollerRef, targetOf, hitTest, update]);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  // Unmounted during a drag (another date…): the window listeners go with it.
  useEffect(() => () => endGesture.current?.(), []);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const current = apiRef.current;
      if (!current || e.button !== 0 || e.pointerType === "touch" || dragRef.current || endGesture.current) return;
      const button = (e.target as HTMLElement).closest<HTMLElement>("[data-trip-ids]");
      const tripId = button?.dataset.tripIds ?? "";
      if (!button || !SINGLE_TRIP.test(tripId) || !current.canDrag(tripId)) return;
      const fromRowId = dropRowIdOf(button, unassignedRowId);
      if (fromRowId === undefined) return;
      const press = { x0: e.clientX, y0: e.clientY, pointerId: e.pointerId, started: false };

      const onMove = (ev: globalThis.PointerEvent) => {
        if (ev.pointerId !== press.pointerId) return;
        if (!press.started) {
          // A click is not a drag: nothing is drawn (nor rendered again) until the pointer moves past the threshold.
          if (Math.hypot(ev.clientX - press.x0, ev.clientY - press.y0) < DRAG_THRESHOLD_PX) return;
          press.started = true;
          document.documentElement.style.userSelect = "none";
        }
        pointer.current = { x: ev.clientX, y: ev.clientY };
        const target = targetOf(tripId, fromRowId, hitTest(ev.clientX, ev.clientY));
        document.documentElement.style.cursor = target?.issue ? "not-allowed" : "grabbing";
        update({ tripId, fromRowId, x: ev.clientX, y: ev.clientY, target, keyboard: false });
        if (frame.current === null) frame.current = requestAnimationFrame(() => tickRef.current());
      };
      const onUp = (ev: globalThis.PointerEvent) => {
        if (ev.pointerId !== press.pointerId) return;
        const state = dragRef.current;
        if (press.started) {
          // The click that follows the release must not select the trip under it.
          suppressClick.current = true;
          window.setTimeout(() => {
            suppressClick.current = false;
          }, 0);
          if (state?.target && state.target.issue === null) {
            apiRef.current?.onDrop(tripId, state.target.rowId === unassignedRowId ? null : state.target.rowId);
          }
        }
        finish();
      };
      const onKey = (ev: globalThis.KeyboardEvent) => {
        if (ev.key !== "Escape" || !press.started) return;
        ev.preventDefault();
        ev.stopPropagation();
        finish();
      };
      function finish() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("keydown", onKey, true);
        endGesture.current = null;
        if (press.started) stop();
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("keydown", onKey, true);
      endGesture.current = finish;
    },
    [unassignedRowId, targetOf, hitTest, update, stop],
  );

  const onClickCapture = useCallback((e: MouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const sayTarget = useCallback(
    (target: DropTarget) => {
      const name = rowLabel(target.rowId);
      const what = target.rowId === unassignedRowId ? "retirer la course de sa tournée" : "déposer la course ici";
      setAnnounce(target.issue ? `${name} : impossible, ${target.issue}` : `${name} : ${what}, Entrée pour confirmer.`);
    },
    [rowLabel, unassignedRowId],
  );

  const onKeyDownCapture = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const state = dragRef.current;
      if (state?.keyboard) {
        const grid = gridRef.current;
        const rows = grid ? Array.from(grid.querySelectorAll<HTMLElement>("[data-pinned-row], [data-vehicle-id]")) : [];
        const ids = rows.map((row) => dropRowIdOf(row, unassignedRowId) ?? "");
        const at = ids.indexOf(state.target?.rowId ?? state.fromRowId);
        let next: number;
        switch (e.key) {
          case "ArrowDown":
            next = at + 1;
            break;
          case "ArrowUp":
            next = at - 1;
            break;
          case "Enter":
          case " ": {
            e.preventDefault();
            e.stopPropagation();
            const target = state.target;
            if (!target || target.rowId === state.fromRowId) {
              setAnnounce("Choisissez une autre ligne avec les flèches haut et bas.");
              return;
            }
            if (target.issue) {
              setAnnounce(`${rowLabel(target.rowId)} : impossible, ${target.issue}`);
              return;
            }
            apiRef.current?.onDrop(state.tripId, target.rowId === unassignedRowId ? null : target.rowId);
            setAnnounce(`Course déposée sur ${rowLabel(target.rowId)} : vérification du brouillon…`);
            stop();
            return;
          }
          case "Escape":
            e.preventDefault();
            e.stopPropagation();
            setAnnounce("Déplacement annulé.");
            stop();
            return;
          case "Tab":
            setAnnounce("Déplacement annulé.");
            stop();
            return;
          default:
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (next < 0 || next >= rows.length) return;
        const rowId = ids[next] ?? "";
        const row = rows[next];
        if (row) reveal(row);
        if (rowId === state.fromRowId) {
          // Its own row: aimed at (the arrows go on from it), never a target.
          update({ ...state, target: { rowId, issue: "la course y est déjà" } });
          setAnnounce(`${rowLabel(rowId)} : la course y est déjà.`);
          return;
        }
        const target = targetOf(state.tripId, state.fromRowId, rowId);
        update({ ...state, target });
        if (target) sayTarget(target);
        return;
      }
      if (e.key.toLowerCase() !== "m" || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const current = apiRef.current;
      const button = (e.target as HTMLElement).closest<HTMLElement>("[data-trip-ids]");
      const tripId = button?.dataset.tripIds ?? "";
      if (!current || !button || !SINGLE_TRIP.test(tripId)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!current.canDrag(tripId)) {
        setAnnounce("Cette course ne peut pas être déplacée maintenant (annulée, commencée, ou planning non modifiable).");
        return;
      }
      const fromRowId = dropRowIdOf(button, unassignedRowId);
      if (fromRowId === undefined) return;
      update({ tripId, fromRowId, x: 0, y: 0, target: null, keyboard: true });
      setAnnounce(
        `Déplacement de la course de ${tripName(tripId)} : flèches haut et bas pour choisir la ligne, Entrée pour déposer, Échap pour annuler.`,
      );
    },
    [gridRef, unassignedRowId, targetOf, update, reveal, rowLabel, sayTarget, stop, tripName],
  );

  // A keyboard move ends when the focus leaves the timeline.
  const keyboard = drag?.keyboard === true;
  useEffect(() => {
    if (!keyboard) return;
    const grid = gridRef.current;
    const onFocusOut = (e: FocusEvent) => {
      if (grid && e.relatedTarget instanceof Node && grid.contains(e.relatedTarget)) return;
      stop();
    };
    grid?.addEventListener("focusout", onFocusOut);
    return () => grid?.removeEventListener("focusout", onFocusOut);
  }, [keyboard, gridRef, stop]);

  return { drag, announce, onPointerDown, onClickCapture, onKeyDownCapture };
}
