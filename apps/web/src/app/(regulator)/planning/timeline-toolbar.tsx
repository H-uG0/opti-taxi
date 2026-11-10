"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { VehicleType } from "@prisma/client";
import { CircleHelp, EyeOff, Lock, Rows3, Rows4, X } from "lucide-react";
import { CheckMenu } from "@/components/ui/check-menu";
import { cn } from "@/components/ui/cn";
import { TimelineLegend } from "@/components/planning/timeline";
import { isTypingTarget, PLANNING_SHORTCUTS, TIMELINE_KEYS, type ShortcutHelp } from "@/lib/planning/shortcuts";
import { EMPTY_FILTER, isFiltering, VEHICLE_STATE_LABELS, viewOptions, type PlanningFilter, type VehicleState } from "@/lib/planning/filter";
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

/** A button opening a small panel under it (locks of the day); Escape or a click outside closes it. */
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

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="inline-flex shrink-0 gap-1">
      {keys.map((key) => (
        <kbd key={key} className="min-w-6 rounded border whitespace-nowrap border-slate-300 bg-slate-50 px-1 text-center font-sans text-[11px] font-semibold text-slate-800 shadow-[0_1px_0_rgb(203_213_225)]">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutList({ title, items }: { title: string; items: readonly ShortcutHelp[] }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>
      <dl className="space-y-1 text-xs text-slate-700">
        {items.map((item) => (
          <div key={item.label} className="flex items-start gap-3">
            <dt className="w-36 shrink-0">
              <Keys keys={item.keys} />
              <span className="sr-only"> : </span>
            </dt>
            <dd>{item.label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * « Aide »: the legend of the timeline and the keyboard shortcuts, in a dialog
 * over the page; « ? » opens and closes it from anywhere (not while typing).
 * Escape, the close button or a click beside it closes it, and the focus goes
 * back where it was.
 */
function HelpDialog({ showReturnToCheck }: { showReturnToCheck: boolean }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const toggle = (next: boolean) => {
    if (next) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.repeat) return;
      const inHelp = (e.target as HTMLElement | null)?.closest?.("[data-planning-help]") != null;
      if (!inHelp && isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen((current) => {
        if (!current) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return !current;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
    else if (returnTo.current?.isConnected) {
      returnTo.current.focus({ preventScroll: true });
      returnTo.current = null;
    }
  }, [open]);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="?"
        title="Légende de la frise et raccourcis clavier (?)"
        onClick={() => toggle(!open)}
        className={cn(
          ICON_BUTTON,
          "h-7 text-xs",
          open ? "border-brand-300 bg-brand-50 text-brand-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        )}
      >
        <CircleHelp aria-hidden className="size-3.5" />
        Aide
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-[80] grid place-items-center bg-slate-900/25 p-4"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) toggle(false);
          }}
        >
          <div
            ref={panel}
            data-planning-help
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                toggle(false);
              } else if (e.key === "Tab") {
                // The focus stays in the dialog: its only control is the close button.
                e.preventDefault();
                panel.current?.querySelector<HTMLElement>("button")?.focus();
              }
            }}
            className="max-h-[min(40rem,calc(100dvh-2rem))] w-[min(50rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 shadow-xl outline-none"
          >
            <div className="mb-3 flex items-start justify-between gap-4">
              <h2 id={titleId} className="text-base font-semibold text-slate-900">
                Aide du planning
              </h2>
              <button
                type="button"
                onClick={() => toggle(false)}
                aria-label="Fermer l'aide"
                className="-m-1 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-brand-600"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
            <div className="grid gap-x-8 gap-y-5 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Légende de la frise</h3>
                <TimelineLegend showReturnToCheck={showReturnToCheck} />
              </section>
              <div className="space-y-4">
                <ShortcutList title="Raccourcis clavier" items={PLANNING_SHORTCUTS} />
                <ShortcutList title="Dans la frise (une seule tabulation)" items={TIMELINE_KEYS} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Above the timeline: the search, the filters (depots, types, states,
 * « Masquer les libres », kept in the URL), the density, the help (legend
 * and shortcuts) and the locks of the whole day. The zoom sits on the
 * timeline's axis.
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
              onClick={() => onChange({ ...EMPTY_FILTER, ...viewOptions(filter) })}
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
          <HelpDialog showReturnToCheck={showReturnToCheck} />
          <Popover label="Figer" icon={<Lock aria-hidden className="size-3.5" />}>
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
