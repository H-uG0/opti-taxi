import type { Metadata } from "next";
import Link from "next/link";
import type { VehicleType } from "@prisma/client";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { FormMessage } from "@/components/ui/form";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadDayCrewContext } from "@/lib/optimizer/build-request";
import { replanBlocker } from "@/lib/planning/run-optimization";
import { absenceOn, absenceText, isQualified, staffName } from "@/lib/staff/day-crews";
import { formatLongDate, fromIsoDate, isIsoDate, isoWeekday, tomorrowIso } from "@/lib/time";
import { DateNav } from "../planning/date-nav";
import { CrewForm, type CrewPersonOption, type CrewRow } from "./crew-form";

export const metadata: Metadata = { title: "Équipages" };

const TYPE_ORDER: Record<VehicleType, number> = { TAXI: 0, VSL: 1, AMBULANCE: 2 };
const TYPES: VehicleType[] = ["TAXI", "VSL", "AMBULANCE"];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CrewsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const requested = Array.isArray(params.date) ? params.date[0] : params.date;
  const tomorrow = tomorrowIso();
  const date = isIsoDate(requested) ? requested : tomorrow;

  const [context, vehicles, depots, locked, routeCount] = await Promise.all([
    loadDayCrewContext(db, date),
    db.vehicle.findMany({ where: { active: true }, select: { id: true, label: true, type: true, registration: true, depotId: true } }),
    db.depot.findMany({ select: { id: true, name: true } }),
    replanBlocker(date),
    db.route.count({ where: { serviceDate: fromIsoDate(date) } }),
    // Everyone's absences of the day are on screen.
    auditRead(user, { action: "day_crew.view", entity: "DayCrew", entityId: null, serviceDate: date }),
  ]);
  const { plan, input } = context;
  const depotName = new Map(depots.map((d) => [d.id, d.name]));
  const crewOf = new Map(plan.crews.map((c) => [c.vehicleId, c]));
  const weekday = isoWeekday(date);

  const rows: CrewRow[] = vehicles
    .map((v) => {
      const crew = crewOf.get(v.id);
      return {
        vehicleId: v.id,
        label: v.label,
        registration: v.registration,
        type: v.type,
        depotId: v.depotId,
        depotName: depotName.get(v.depotId) ?? "?",
        driverId: crew?.driverId ?? null,
        crewMateId: crew?.crewMateId ?? null,
        source: crew?.source ?? "none",
        issues: crew?.issues ?? [],
        blocked: crew?.blocked ?? null,
        unavailable: crew?.unavailable ?? false,
      };
    })
    .sort(
      (a, b) =>
        a.depotName.localeCompare(b.depotName, "fr") ||
        TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
        a.label.localeCompare(b.label, "fr", { numeric: true }),
    );

  const assigned = new Set(rows.flatMap((r) => [r.driverId, r.crewMateId]).filter((id): id is string => id !== null));
  const people: CrewPersonOption[] = input.people
    .filter((p) => p.active || assigned.has(p.id))
    .sort((a, b) => a.lastName.localeCompare(b.lastName, "fr") || a.firstName.localeCompare(b.firstName, "fr"))
    .map((p) => {
      const absence = absenceOn(p.id, date, input.absences);
      return {
        id: p.id,
        name: `${p.lastName.toUpperCase()} ${p.firstName}`,
        active: p.active,
        depotId: p.depotId,
        absence: absence ? absenceText(absence).toLowerCase() : null,
        worksThatDay: p.workDays.includes(weekday),
        canDrive: Object.fromEntries(TYPES.map((t) => [t, isQualified(p, t, "driver")])) as Record<VehicleType, boolean>,
        canCrew: isQualified(p, "AMBULANCE", "crewMate"),
      };
    });

  const nameOf = (id: string) => {
    const p = context.people.get(id);
    return p ? staffName(p) : "?";
  };
  const ready = plan.crews.filter((c) => c.blocked === null).length;
  const blocked = plan.crews.length - ready;
  const hasSavedCrews = input.saved.length > 0;

  return (
    <>
      <PageHeader
        title={`Équipages du ${formatLongDate(date)}`}
        description={`${ready} véhicule${ready > 1 ? "s" : ""} avec équipage${blocked > 0 ? ` · ${blocked} sans équipage complet (non planifié${blocked > 1 ? "s" : ""})` : ""} · ${plan.absent.length} absence${plan.absent.length > 1 ? "s" : ""}`}
        actions={<DateNav date={date} tomorrow={tomorrow} basePath="/equipages" />}
      />

      <div className="space-y-6">
        {locked ? <FormMessage tone="info">Équipages non modifiables : {locked}</FormMessage> : null}
        {!locked && routeCount > 0 ? (
          <FormMessage tone="info">
            Des tournées sont déjà calculées pour ce jour avec leurs équipages. Après un changement ici, relancez
            l&apos;optimisation depuis le{" "}
            <Link href={`/planning?date=${date}`} className="font-medium underline">
              planning
            </Link>
            .
          </FormMessage>
        ) : null}
        <p className="text-sm text-slate-600">
          {hasSavedCrews
            ? "Équipages fixés pour ce jour : l'optimisation les utilise tels quels."
            : "Équipages proposés automatiquement : équipage attitré quand il est disponible, sinon un remplaçant qualifié, du même dépôt d'abord. Enregistrez pour les fixer ou les modifier."}
        </p>

        <CrewForm date={date} rows={rows} people={people} locked={locked} hasSavedCrews={hasSavedCrews} />

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader title={`Absents ce jour (${plan.absent.length})`} />
            <CardBody className="text-sm text-slate-700">
              {plan.absent.length === 0 ? (
                <p className="text-slate-500">Aucune absence enregistrée pour ce jour.</p>
              ) : (
                <ul className="space-y-1">
                  {plan.absent.map((a) => (
                    <li key={`${a.driverId}-${a.startDate}`}>
                      <Link href={`/chauffeurs/${a.driverId}`} className="font-medium underline-offset-2 hover:underline">
                        {nameOf(a.driverId)}
                      </Link>{" "}
                      — {absenceText(a)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-slate-500">Congés, arrêts, formations et gardes se saisissent dans la fiche de chaque chauffeur.</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={`Disponibles sans véhicule (${plan.idle.length})`} />
            <CardBody className="text-sm text-slate-700">
              {plan.idle.length === 0 ? (
                <p className="text-slate-500">Personne : tout le personnel disponible a un poste.</p>
              ) : (
                <ul className="space-y-1">
                  {plan.idle.map((id) => {
                    const p = context.people.get(id);
                    return (
                      <li key={id}>
                        <Link href={`/chauffeurs/${id}`} className="font-medium underline-offset-2 hover:underline">
                          {nameOf(id)}
                        </Link>
                        {p?.depotId ? <span className="text-slate-500"> · {depotName.get(p.depotId)}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
