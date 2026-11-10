"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Car, Search, UserRound } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { searchPlanning, type SearchResult } from "@/lib/planning/search";
import { isShortcutKey } from "@/lib/planning/shortcuts";
import type { TripView, VehicleRowView } from "@/lib/planning/types";

/**
 * Search box of the planning (« / » from anywhere on the page): a patient, a
 * vehicle, a driver or a facility. A combobox: arrows to move, Enter to
 * choose, Escape to close. Choosing a trip selects it (its row is scrolled
 * into view, the map framed on it); a vehicle, its route.
 */
export function PlanningSearch({
  trips,
  vehicles,
  onSelectTrip,
  onShowVehicle,
  className,
}: {
  trips: readonly TripView[];
  vehicles: readonly VehicleRowView[];
  onSelectTrip: (tripId: string) => void;
  onShowVehicle: (vehicleId: string) => void;
  className?: string;
}) {
  const inputId = useId();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchPlanning(query, trips, vehicles), [query, trips, vehicles]);
  const showList = open && query.trim().length >= 2;
  const current = results[Math.min(active, results.length - 1)] ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The rule of every shortcut of the help: not while typing nor in a dialog (« Aide », a « +3 » list).
      if (e.key !== "/" || !isShortcutKey(e)) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // The active option stays visible in the list.
  useEffect(() => {
    if (!showList || !current) return;
    document.getElementById(`${listId}-${current.kind}-${current.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [showList, current, listId]);

  const choose = (result: SearchResult) => {
    setOpen(false);
    if (result.kind === "trip") onSelectTrip(result.id);
    else onShowVehicle(result.id);
  };

  return (
    <div
      ref={wrapper}
      className={cn("relative", className)}
      // Leaving with Tab (or a click elsewhere) closes the list: it never covers the timeline behind the focus.
      onBlur={(e) => {
        if (!wrapper.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Rechercher un patient, un véhicule, un chauffeur ou un établissement (raccourci : barre oblique)
      </label>
      <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input
        ref={input}
        id={inputId}
        type="search"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && current ? `${listId}-${current.kind}-${current.id}` : undefined}
        placeholder="Patient, véhicule, chauffeur…"
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            if (results.length === 0) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (Math.min(i, results.length - 1) + step + results.length) % results.length);
          } else if (e.key === "Enter") {
            if (showList && current) {
              e.preventDefault();
              choose(current);
            }
          } else if (e.key === "Escape") {
            // Handled here: the board's Escape (clear the selection) is for the timeline.
            e.stopPropagation();
            if (showList) setOpen(false);
            else if (query) setQuery("");
            else input.current?.blur();
          }
        }}
        className="block h-8 w-full rounded-md border border-slate-300 bg-white pl-8 pr-8 text-sm text-slate-900 shadow-xs placeholder:text-slate-400 focus:border-brand-500 focus:outline-2 focus:outline-brand-200"
      />
      {query === "" ? (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-slate-300 bg-slate-50 px-1.5 text-[11px] font-medium text-slate-500"
        >
          /
        </kbd>
      ) : null}
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          // Not a Tab stop (Chrome makes a scrolling box focusable): the arrows of the field move in it.
          tabIndex={-1}
          aria-label="Résultats de la recherche"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 min-w-72 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {results.length === 0 ? (
            <li role="option" aria-selected={false} aria-disabled className="px-3 py-2 text-sm text-slate-500">
              Aucun patient, véhicule, chauffeur ni établissement ne correspond.
            </li>
          ) : (
            results.map((result) => {
              const selected = current === result;
              const Icon = result.kind === "trip" ? UserRound : Car;
              return (
                <li
                  key={`${result.kind}-${result.id}`}
                  id={`${listId}-${result.kind}-${result.id}`}
                  role="option"
                  aria-selected={selected}
                  // Pointer down, not click: the input keeps the focus and the list does not close before the choice.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    choose(result);
                  }}
                  onPointerMove={() => setActive(results.indexOf(result))}
                  className={cn("flex cursor-pointer items-start gap-2 px-3 py-1.5", selected ? "bg-brand-50" : "hover:bg-slate-50")}
                >
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-slate-400" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-900">{result.title}</span>
                    <span className="block truncate text-xs text-slate-500">{result.detail}</span>
                  </span>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
