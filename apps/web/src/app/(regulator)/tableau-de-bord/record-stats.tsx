import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/layout";
import { db } from "@/lib/db";
import { lineRates, routeLines, sumLines } from "@/lib/kpis-breakdown";
import { loadRouteKpiRows } from "@/lib/kpis-load";
import { DEFAULT_KPI_OPTIONS } from "@/lib/kpis-rows";
import { formatKm } from "@/lib/labels";
import { addDays, formatShortDate, fromIsoDate, todayIso, toIsoDate } from "@/lib/time";
import { formatDecimal, formatEurosRounded, formatRate, plural } from "./format";
import { dashboardHref } from "./query";

/** Days of a record's figures, today included. */
export const RECORD_STATS_DAYS = 30;

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="tabular font-medium text-slate-900">
        {value}
        {hint ? <span className="block text-xs font-normal text-slate-500">{hint}</span> : null}
      </dd>
    </div>
  );
}

/**
 * The figures of a vehicle or a person over the last RECORD_STATS_DAYS days
 * (KPI-02): its routes, the trips placed on them, km, money, lateness and the
 * statuses its crews recorded, with the dashboard's formulas
 * (lib/kpis-breakdown.ts); a vehicle's days off the road are counted like the
 * dashboard's (days with routes, the vehicle unavailable and unused). The
 * link opens the dashboard's breakdown.
 */
export async function RecordStats({ owner }: { owner: { vehicleId: string; costPerKm: number } | { personId: string } }) {
  const today = todayIso();
  const from = addDays(today, -(RECORD_STATS_DAYS - 1));
  const vehicle = "vehicleId" in owner;
  const [data, outages, plannedRows] = await Promise.all([
    loadRouteKpiRows(db, { from, to: today }, vehicle ? { vehicleId: owner.vehicleId } : { personId: owner.personId }),
    vehicle
      ? db.vehicleUnavailability.findMany({
          where: { vehicleId: owner.vehicleId, startDate: { lte: fromIsoDate(today) }, endDate: { gte: fromIsoDate(from) } },
          select: { startDate: true, endDate: true },
        })
      : Promise.resolve([]),
    // The days with routes (any vehicle): a day off the road counts on those only, like the dashboard.
    vehicle
      ? db.route.findMany({
          where: { serviceDate: { gte: fromIsoDate(from), lte: fromIsoDate(today) }, stops: { some: {} } },
          distinct: ["serviceDate"],
          select: { serviceDate: true },
        })
      : Promise.resolve([]),
  ]);
  const plannedDays = new Set(plannedRows.map((r) => toIsoDate(r.serviceDate)));
  const usedDays = new Set(data.routes.filter((r) => r.stopCount > 0).map((r) => r.serviceDate));
  const totals = sumLines(routeLines(data, today, DEFAULT_KPI_OPTIONS, () => (vehicle ? owner.costPerKm : undefined)));
  const rates = lineRates(totals);
  const offRoad = new Set<string>();
  for (const outage of outages) {
    for (let day = toIsoDate(outage.startDate); day <= toIsoDate(outage.endDate); day = addDays(day, 1)) {
      if (day >= from && day <= today && plannedDays.has(day) && !usedDays.has(day)) offRoad.add(day);
    }
  }
  const href = dashboardHref({ tab: "ventilation", from, to: today, axis: vehicle ? "vehicule" : "chauffeur" });
  return (
    <Card>
      <CardHeader
        title={`Activité des ${RECORD_STATS_DAYS} derniers jours`}
        actions={
          <Link href={href} className="text-sm font-medium text-brand-700 underline underline-offset-2">
            Comparer dans le tableau de bord
          </Link>
        }
      />
      <CardBody>
        {totals.vehicleDays === 0 ? (
          <p className="text-sm text-slate-600">
            Aucune tournée {vehicle ? "de ce véhicule" : "conduite ou en équipage"} du {formatShortDate(from)} à aujourd&apos;hui
            {vehicle && offRoad.size > 0 ? ` · ${plural(offRoad.size, "jour immobilisé", "jours immobilisés")}` : ""}.
          </p>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
            <Figure
              label={vehicle ? "Jours avec une tournée" : "Jours travaillés"}
              value={String(totals.days)}
              hint={vehicle ? plural(offRoad.size, "jour immobilisé", "jours immobilisés") : plural(totals.vehicleDays, "tournée")}
            />
            <Figure label="Courses servies" value={String(totals.trips)} hint={`${formatDecimal(rates.tripsPerVehicleDay)} par jour`} />
            <Figure label="Km" value={formatKm(totals.distanceKm, 0)} hint={`${formatRate(rates.emptyKmShare)} à vide`} />
            <Figure label="CA estimé" value={formatEurosRounded(totals.revenue)} hint={`marge ${formatEurosRounded(rates.margin)}`} />
            {vehicle ? (
              <>
                <Figure label="Marge par course" value={formatEurosRounded(rates.marginPerTrip)} />
                <Figure label="Taux d'occupation" value={formatRate(rates.occupancy)} hint="temps avec un patient à bord" />
                <Figure label="Partage (CPAM)" value={formatRate(rates.sharedRate)} hint={`${totals.eligibleShared} sur ${plural(totals.eligible, "éligible")}`} />
              </>
            ) : (
              <>
                <Figure
                  label="Retards au RDV"
                  value={totals.measuredOutbound > 0 ? `${totals.lateArrivals} / ${totals.measuredOutbound}` : "—"}
                  hint={`au-delà de ${DEFAULT_KPI_OPTIONS.lateToleranceMin} min, allers mesurés`}
                />
                <Figure label="Saisie des statuts" value={formatRate(rates.recordingRate)} hint="issue saisie, jours terminés" />
                <Figure label="Heures planifiées" value={`${formatDecimal(rates.plannedHours, 0)} h`} />
              </>
            )}
          </dl>
        )}
      </CardBody>
    </Card>
  );
}
