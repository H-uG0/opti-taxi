import { Stat } from "@/components/ui/layout";
import { formatDecimal, formatEurosRounded, formatKmRounded, pluralize } from "@/lib/planning/format";
import type { DayKpis } from "@/lib/planning/types";
import { formatPercent } from "@/lib/labels";

/** Indicators of the day, computed from the saved routes. */
export function KpiStrip({ kpis, availableVehicles }: { kpis: DayKpis; availableVehicles: number }) {
  const unassigned = kpis.tripsTotal - kpis.tripsServed;
  return (
    <section aria-label="Indicateurs du jour" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-9">
      <Stat
        label="Courses servies"
        value={`${kpis.tripsServed} / ${kpis.tripsTotal}`}
        hint={unassigned > 0 ? pluralize(unassigned, "non affectée", "non affectées") : "toutes affectées"}
        tone={unassigned > 0 ? "warn" : kpis.tripsTotal > 0 ? "good" : "default"}
      />
      <Stat label="Véhicules utilisés" value={kpis.vehiclesUsed} hint={`sur ${pluralize(availableVehicles, "disponible", "disponibles")}`} />
      <Stat label="Courses / véhicule" value={formatDecimal(kpis.tripsPerVehicle)} />
      <Stat label="Km total" value={formatKmRounded(kpis.totalKm)} />
      <Stat label="Km à vide" value={formatPercent(kpis.emptyKmRatio)} hint={formatKmRounded(kpis.emptyKm)} />
      <Stat label="Transport partagé" value={formatPercent(kpis.sharedTripRatio)} hint={pluralize(kpis.sharedTrips, "course partagée", "courses partagées")} />
      <Stat label="CA estimé" value={formatEurosRounded(kpis.revenue)} />
      <Stat label="Marge estimée" value={formatEurosRounded(kpis.margin)} tone={kpis.margin < 0 ? "bad" : "default"} />
      <Stat
        label="Violations"
        value={kpis.violations ?? "?"}
        hint={kpis.violations === null ? "détail indisponible : réoptimisez" : kpis.violations > 0 ? "contraintes dures" : "planning conforme"}
        tone={kpis.violations === null ? "warn" : kpis.violations > 0 ? "bad" : "good"}
      />
    </section>
  );
}
