import type { Metadata } from "next";
import Link from "next/link";
import type { VehicleType } from "@prisma/client";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/layout";
import { SimulatedDayBadge } from "@/components/planning/simulated-day-badge";
import { FormMessage } from "@/components/ui/form";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSimulatedDay } from "@/lib/simulated-day";
import { loadDayCrewContext } from "@/lib/optimizer/build-request";
import { vehicleIssues } from "@/lib/planning/route-issues";
import { replanBlocker } from "@/lib/planning/run-optimization";
import { absenceOn, isQualified, planningAbsenceText, staffName } from "@/lib/staff/day-crews";
import { formatLongDate, fromIsoDate, isIsoDate, isoWeekday, todayIso, tomorrowIso } from "@/lib/time";
import { DateNav } from "../planning/date-nav";
import { Callout } from "../vehicules/_lib/ui";
import { CrewForm, type CrewPersonOption, type CrewRow } from "./crew-form";
import { crewOrigin } from "./schema";

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

  const [context, vehicles, depots, locked, routes, simulated] = await Promise.all([
    loadDayCrewContext(db, date),
    db.vehicle.findMany({ where: { active: true }, select: { id: true, label: true, type: true, registration: true, depotId: true } }),
    db.depot.findMany({ select: { id: true, name: true } }),
    replanBlocker(date),
    db.route.findMany({ where: { serviceDate: fromIsoDate(date) }, select: { vehicleId: true, driverId: true, crewMateId: true } }),
    isSimulatedDay(date),
    // Everyone's absences of the day are on screen.
    auditRead(user, { action: "day_crew.view", entity: "DayCrew", entityId: null, serviceDate: date }),
  ]);
  const { plan, input } = context;
  const routeCount = routes.length;
  // The same list as the planning's « À traiter » (lib/planning/route-issues.ts).
  const issues = vehicleIssues({
    date,
    routes,
    vehicles: input.vehicles,
    plan,
    absences: input.absences,
    people: context.people,
    fleetAlerts: context.fleetAlerts,
  });
  const depotName = new Map(depots.map((d) => [d.id, d.name]));
  const crewOf = new Map(plan.crews.map((c) => [c.vehicleId, c]));
  const weekday = isoWeekday(date);

  const rows: CrewRow[] = vehicles
    .map((v) => {
      const crew = crewOf.get(v.id);
      const fixed = context.savedMeta.get(v.id);
      return {
        vehicleId: v.id,
        label: v.label,
        registration: v.registration,
        type: v.type,
        depotId: v.depotId,
        depotName: depotName.get(v.depotId) ?? "?",
        driverId: crew?.driverId ?? null,
        crewMateId: crew?.crewMateId ?? null,
        origin: crew ? crewOrigin(crew) : "none",
        proposedSeats: crew?.proposedSeats ?? [],
        // An unavailable vehicle keeps no crew (saveDayCrews): its old fixed row is not offered.
        fixed: fixed && !crew?.unavailable ? { version: fixed.updatedAt.toISOString(), by: fixed.updatedBy } : null,
        savedVersion: fixed ? fixed.updatedAt.toISOString() : null,
        shift: crew?.shift ?? null,
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
  const labelOf = new Map(vehicles.map((v) => [v.id, v.label]));
  const vehicleOfPerson = new Map<string, string>();
  for (const crew of plan.crews) {
    for (const id of [crew.driverId, crew.crewMateId]) if (id && !vehicleOfPerson.has(id)) vehicleOfPerson.set(id, crew.vehicleId);
  }
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
        absence: absence ? planningAbsenceText(absence).toLowerCase() : null,
        worksThatDay: p.workDays.includes(weekday),
        canDrive: Object.fromEntries(TYPES.map((t) => [t, isQualified(p, t, "driver")])) as Record<VehicleType, boolean>,
        canCrew: isQualified(p, "AMBULANCE", "crewMate"),
        vehicleId: vehicleOfPerson.get(p.id) ?? null,
        vehicleLabel: labelOf.get(vehicleOfPerson.get(p.id) ?? "") ?? null,
      };
    });

  const nameOf = (id: string) => {
    const p = context.people.get(id);
    return p ? staffName(p) : "?";
  };
  const ready = plan.crews.filter((c) => c.blocked === null).length;
  const parked = plan.crews.filter((c) => c.parked).length;
  const blocked = plan.crews.length - ready - parked;
  const hasSavedCrews = input.saved.length > 0;
  const fixedCount = rows.filter((r) => r.fixed !== null).length;
  const summary = [
    `${ready} véhicule${ready > 1 ? "s" : ""} avec équipage`,
    // A seat nobody fills, or hours over 6 hours without a legal break: the problems column says which.
    blocked > 0 ? `${blocked} non planifié${blocked > 1 ? "s" : ""} (équipage à revoir)` : null,
    parked > 0 ? `${parked} laissé${parked > 1 ? "s" : ""} au dépôt` : null,
    `${plan.absent.length} absence${plan.absent.length > 1 ? "s" : ""}`,
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>Équipages du {formatLongDate(date)}</span>
            {simulated ? <SimulatedDayBadge /> : null}
          </span>
        }
        description={summary.join(" · ")}
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
        {issues.length > 0 ? (
          <Callout tone="warning" title={`Véhicules à revoir (${issues.length})`}>
            {issues.some((issue) => issue.changes.length > 0) ? (
              locked ? (
                // Re-planning is not possible now: say why instead of asking for it.
                <p>
                  Des tournées ont été calculées avant un changement de véhicule ou d&apos;équipage. {locked}
                  {date >= todayIso()
                    ? " Pour remplacer une personne sans réoptimiser : planning, panneau du véhicule, « Changer l'équipage »."
                    : ""}{" "}
                  <Link href={`/planning?date=${date}`} className="font-medium underline">
                    Ouvrir le planning
                  </Link>
                </p>
              ) : (
                <p>
                  Des tournées ont été calculées avant un changement de véhicule ou d&apos;équipage : relancez
                  l&apos;optimisation depuis le{" "}
                  <Link href={`/planning?date=${date}`} className="font-medium underline">
                    planning
                  </Link>{" "}
                  pour appliquer les équipages ci-dessous.
                </p>
              )
            ) : null}
            {issues.some((issue) => issue.compliance.length > 0) ? (
              <p>Échéance dépassée : vérifiez le véhicule avant de le faire rouler.</p>
            ) : null}
            <ul className="list-disc space-y-0.5 pl-5">
              {issues.map((issue) => (
                <li key={issue.vehicleId}>
                  <span className="font-medium">{issue.label}</span>
                  {issue.hasRoute ? "" : " (sans tournée)"} — {[...issue.changes, ...issue.compliance].join(" ; ")}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
        <p className="text-sm text-slate-600">
          {fixedCount > 0
            ? `${fixedCount} équipage${fixedCount > 1 ? "s fixés" : " fixé"} pour ce jour, utilisé${fixedCount > 1 ? "s" : ""} tel${fixedCount > 1 ? "s" : ""} quel${fixedCount > 1 ? "s" : ""} par l'optimisation. Les autres véhicules ont leur`
            : "Chaque véhicule a son"}{" "}
          équipage attitré quand il est disponible, sinon un remplaçant qualifié : du même dépôt d&apos;abord, puis du
          dépôt le plus proche (Paramètres, « Équipages »), qui couvre l&apos;horaire du titulaire, en gardant les
          ambulanciers DE pour les ambulances. Modifiez une ligne pour la fixer, ou « Fixer cette proposition » pour
          garder le remplaçant proposé.
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
                      — {a.text.toLowerCase()}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-slate-500">
                Les absences se saisissent dans la fiche de chaque chauffeur ; leur motif n&apos;est visible que là.
              </p>
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
