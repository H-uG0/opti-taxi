import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { formatDecimal, formatEurosRounded, formatKmRounded, pluralize } from "@/lib/planning/format";
import type { DayKpis } from "@/lib/planning/types";
import { formatPercent } from "@/lib/labels";

type Tone = "default" | "good" | "warn" | "bad";

const TONES: Record<Tone, string> = {
  default: "text-slate-900",
  good: "text-emerald-700",
  warn: "text-amber-700",
  bad: "text-red-700",
};

/** One figure of the strip: label, value, hint (on one line each, the full label as a tooltip). */
function Figure({ label, title, value, hint, tone = "default" }: { label: string; title?: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 px-3 py-1" title={title}>
      <p className="truncate text-[11px] font-medium text-slate-500">{label}</p>
      <p className={cn("tabular truncate text-base leading-6 font-semibold", TONES[tone])}>{value}</p>
      {hint ? <p className="truncate text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

/**
 * Indicators of the day, computed from the saved routes, on one line from
 * 1 280 px. With a filter on (`scope`), the figures are those of the vehicles
 * shown (same formulas); the trips without a vehicle stay counted for the day.
 */
export function KpiStrip({
  kpis,
  availableVehicles,
  scope = null,
}: {
  kpis: DayKpis;
  availableVehicles: number;
  /** Filtered view: vehicles shown, and the day's trips without a vehicle. */
  scope?: { vehicles: number; unassignedDay: number } | null;
}) {
  const unassigned = scope ? scope.unassignedDay : kpis.tripsTotal - kpis.tripsServed;
  const unassignedHint = unassigned > 0 ? pluralize(unassigned, "non affectée", "non affectées") : "toutes affectées";
  // No vehicle shown: nothing to judge (never « conforme » in green over an empty timeline).
  const noVehicle = scope !== null && scope.vehicles === 0;
  return (
    <section
      aria-label={scope ? `Indicateurs des ${pluralize(scope.vehicles, "véhicule affiché", "véhicules affichés")}` : "Indicateurs du jour"}
      className={cn(
        "grid grid-cols-3 divide-slate-100 rounded-lg border bg-white shadow-xs sm:grid-cols-5 xl:grid-cols-9 xl:divide-x",
        scope ? "border-brand-200" : "border-slate-200",
      )}
    >
      {scope ? (
        <Figure
          label="Courses servies"
          title={`Courses servies par les véhicules affichés ; ${unassignedHint} sur la journée (une course sans véhicule n'est à aucun dépôt)`}
          value={kpis.tripsServed}
          hint={unassigned > 0 ? `${unassigned} à placer (jour)` : "toutes placées"}
          tone={unassigned > 0 ? "warn" : "default"}
        />
      ) : (
        <Figure
          label="Courses servies"
          value={`${kpis.tripsServed} / ${kpis.tripsTotal}`}
          hint={unassignedHint}
          tone={unassigned > 0 ? "warn" : kpis.tripsTotal > 0 ? "good" : "default"}
        />
      )}
      <Figure
        label="Véhicules"
        title={
          scope
            ? `Véhicules utilisés sur les ${scope.vehicles} affichés`
            : `Véhicules utilisés sur les ${availableVehicles} disponibles ce jour`
        }
        value={kpis.vehiclesUsed}
        hint={scope ? `sur ${scope.vehicles} affichés` : `sur ${availableVehicles} dispo.`}
      />
      <Figure label="Courses / véh." title="Courses servies par véhicule utilisé" value={formatDecimal(kpis.tripsPerVehicle)} />
      <Figure label="Km total" title={scope ? "Km des tournées des véhicules affichés" : "Km de toutes les tournées"} value={formatKmRounded(kpis.totalKm)} />
      <Figure label="Km à vide" title="Part des km roulés sans patient à bord" value={formatPercent(kpis.emptyKmRatio)} hint={formatKmRounded(kpis.emptyKm)} />
      <Figure
        label="Partagé"
        title="Transport partagé : part des courses servies avec un autre patient à bord"
        value={formatPercent(kpis.sharedTripRatio)}
        hint={pluralize(kpis.sharedTrips, "course", "courses")}
      />
      <Figure label="CA estimé" title="Chiffre d'affaires estimé avec les grilles tarifaires en vigueur" value={formatEurosRounded(kpis.revenue)} />
      <Figure
        label="Marge estimée"
        title="CA estimé moins le coût des km et des heures de tournée (coûts variables, paramètres des véhicules et des chauffeurs)"
        value={formatEurosRounded(kpis.margin)}
        hint="coûts variables"
        tone={kpis.margin < 0 ? "bad" : "default"}
      />
      {noVehicle ? (
        <Figure label="Violations" value="—" title="Aucun véhicule affiché avec ces filtres" hint="aucun véhicule" />
      ) : (
        <Figure
          label="Violations"
          value={kpis.violations ?? "?"}
          title={kpis.violations === null ? "Détail indisponible : réoptimisez" : "Contraintes dures non respectées (horaires, capacité, détour, attente…)"}
          hint={kpis.violations === null ? "à réoptimiser" : kpis.violations > 0 ? "contraintes dures" : "conforme"}
          tone={kpis.violations === null ? "warn" : kpis.violations > 0 ? "bad" : "good"}
        />
      )}
    </section>
  );
}
