"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { VehicleType } from "@prisma/client";
import { CircleHelp, EyeOff, Lock, Rows3, Rows4 } from "lucide-react";
import { CheckMenu } from "@/components/ui/check-menu";
import { cn } from "@/components/ui/cn";
import { TimelineLegend } from "@/components/planning/timeline";
import { EMPTY_FILTER, isFiltering, VEHICLE_STATE_LABELS, type PlanningFilter, type VehicleState } from "@/lib/planning/filter";
import { pluralize } from "@/lib/planning/format";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";

const TYPES: VehicleType[] = ["TAXI", "VSL", "AMBULANCE"];
const STATES: VehicleState[] = ["route", "free", "off", "issue"];

const ICON_BUTTON =
  "inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/** Summary of a multiple choice: « tous », the names (up to 2) or the count. */
function summaryOf(selected: readonly string[], names: ReadonlyMap<string, string>, all: string): string {
  if (selected.length === 0) return all;
  if (selected.length <= 2) return selected.map((id) => names.get(id) ?? "?").join(", ");
  return `${selected.length}`;
}

/** A button opening a small panel under it (legend, locks of the day); Escape or a click outside closes it. */
function Popover({ label, icon, children, align = "right" }: { label: string; icon: ReactNode; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  return (
    <div
      ref={wrapper}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          ICON_BUTTON,
          "h-7 text-xs",
          open ? "border-brand-300 bg-brand-50 text-brand-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        )}
      >
        {icon}
        <span>{label}</span>
      </button>
      {open ? (
        <div
          role="group"
          aria-label={label}
          className={cn(
            "absolute top-full z-50 mt-1 w-max max-w-[min(32rem,calc(100vw-2rem))] rounded-md border border-slate-200 bg-white p-3 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Above the timeline: the search, the filters (depots, types, states,
 * « Masquer les libres », kept in the URL), the density, the legend and the
 * locks of the whole day.
 */
export function TimelineToolbar({
  search,
  filter,
  onChange,
  depots,
  shown,
  total,
  dayLocks,
  showReturnToCheck,
}: {
  search: ReactNode;
  filter: PlanningFilter;
  onChange: (next: PlanningFilter) => void;
  depots: ReadonlyArray<{ id: string; label: string; count: number }>;
  /** Vehicles shown / of the day. */
  shown: number;
  total: number;
  /** « Figer / Défiger toute la journée ». */
  dayLocks: ReactNode;
  showReturnToCheck: boolean;
}) {
  const depotNames = new Map(depots.map((d) => [d.id, d.label]));
  const typeNames = new Map(TYPES.map((t) => [t, VEHICLE_TYPE_SHORT[t]]));
  const stateNames = new Map(STATES.map((s) => [s, VEHICLE_STATE_LABELS[s]]));
  const filtering = isFiltering(filter);
  return (
    <div className="space-y-1.5 border-b border-slate-200 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1 basis-48">{search}</div>
        <CheckMenu
          label="Dépôts"
          summary={summaryOf(filter.depots, depotNames, "tous")}
          options={depots.map((d) => ({ value: d.id, label: d.label, hint: d.count }))}
          selected={filter.depots}
          onChange={(values) => onChange({ ...filter, depots: values })}
        />
        <CheckMenu
          label="Types"
          summary={summaryOf(filter.types, typeNames, "tous")}
          options={TYPES.map((t) => ({ value: t, label: VEHICLE_TYPE_SHORT[t] }))}
          selected={filter.types}
          onChange={(values) => onChange({ ...filter, types: values as VehicleType[] })}
        />
        <CheckMenu
          label="État"
          summary={summaryOf(filter.states, stateNames, "tous")}
          options={STATES.map((s) => ({ value: s, label: VEHICLE_STATE_LABELS[s] }))}
          selected={filter.states}
          onChange={(values) => onChange({ ...filter, states: values as VehicleState[] })}
          allLabel="Tous les états"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          aria-pressed={filter.hideFree}
          onClick={() => onChange({ ...filter, hideFree: !filter.hideFree })}
          title="Cache les véhicules disponibles sans tournée"
          className={cn(
            ICON_BUTTON,
            "h-7 text-xs",
            filter.hideFree ? "border-brand-300 bg-brand-50 text-brand-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
          )}
        >
          <EyeOff aria-hidden className="size-3.5" />
          Masquer les libres
        </button>
        <p className="flex flex-wrap items-center gap-x-3 text-xs text-slate-500" aria-live="polite">
          <span className="tabular">
            {filtering ? `${shown} sur ${pluralize(total, "véhicule")} affichés` : `${pluralize(total, "véhicule")}`}
            {depots.length > 1 && !filtering ? ` · ${pluralize(depots.length, "dépôt")}` : ""}
          </span>
          {filtering ? (
            <button
              type="button"
              onClick={() => onChange({ ...EMPTY_FILTER, collapsed: filter.collapsed, compact: filter.compact })}
              className="font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
            >
              Réinitialiser les filtres
            </button>
          ) : null}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-pressed={filter.compact}
            onClick={() => onChange({ ...filter, compact: !filter.compact })}
            title={filter.compact ? "Revenir aux lignes détaillées (équipage, chiffres)" : "Lignes de 28 px sur une ligne : plus de véhicules à l'écran"}
            className={cn(
              ICON_BUTTON,
              "h-7 text-xs",
              filter.compact ? "border-brand-300 bg-brand-50 text-brand-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
            )}
          >
            {filter.compact ? <Rows4 aria-hidden className="size-3.5" /> : <Rows3 aria-hidden className="size-3.5" />}
            Compacte
          </button>
          <Popover label="Légende" icon={<CircleHelp aria-hidden className="size-3.5" />}>
            <TimelineLegend showReturnToCheck={showReturnToCheck} />
          </Popover>
          <Popover label="Verrous" icon={<Lock aria-hidden className="size-3.5" />}>
            <div className="w-72 space-y-2 text-sm text-slate-700">
              <p>
                Une course figée reste sur son véhicule aux prochaines optimisations. Figez une tournée depuis son véhicule,
                un dépôt depuis son en-tête dans la frise.
              </p>
              {dayLocks}
            </div>
          </Popover>
        </div>
      </div>
    </div>
  );
}
