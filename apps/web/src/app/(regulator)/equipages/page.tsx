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
import { compareLabels, comparePeople, compareVehiclesByDepot } from "@/lib/fleet/order";
import { absenceOn, depotDistanceKm, isQualified, planningAbsenceText, staffName } from "@/lib/staff/day-crews";
import { formatDayDate, formatLongDate, fromIsoDate, isIsoDate, isoWeekday, todayIso, tomorrowIso } from "@/lib/time";
import { DayTabs } from "@/components/nav/day-tabs";
import { DayNav } from "@/components/ui/day-nav";
import { CrewForm, type CrewDepots, type CrewPersonOption, type CrewRow } from "./crew-form";
import { QUALIFICATION_SHORT, QUALIFICATIONS } from "../chauffeurs/schema";
import { crewOrigin } from "./schema";
import { Notice } from "@/components/ui/notice";
import { formatPersonName } from "@/lib/names";

/** The tab says which day: « Équipages 12/11 ». */
export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const raw = (await searchParams).date;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  return { title: `Équipages ${formatDayDate(isIsoDate(requested) ? requested : tomorrowIso())}` };
}

/** The filter of the page (depot, « à traiter seulement ») follows from one date to the next. */
const KEPT_PARAMS = ["depot", "etat"] as const;

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
  const flagged = new Set(issues.map((issue) => issue.vehicleId));
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
        flagged: flagged.has(v.id),
      };
    })
    // The same order everywhere (lib/fleet/order.ts): depot, type, label in numeric order.
    .sort(compareVehiclesByDepot);

  const assigned = new Set(rows.flatMap((r) => [r.driverId, r.crewMateId]).filter((id): id is string => id !== null));
  // The people once for the whole page: each seat builds its choices when it is opened (crew-form.tsx).
  const people: CrewPersonOption[] = input.people
    .filter((p) => p.active || assigned.has(p.id))
    .sort(comparePeople)
    .map((p) => {
      const absence = absenceOn(p.id, date, input.absences);
      return {
        id: p.id,
        name: formatPersonName(p),
        active: p.active,
        depotId: p.depotId,
        absence: absence ? planningAbsenceText(absence).toLowerCase() : null,
        worksThatDay: p.workDays.includes(weekday),
        canDrive: Object.fromEntries(TYPES.map((t) => [t, isQualified(p, t, "driver")])) as Record<VehicleType, boolean>,
        canCrew: isQualified(p, "AMBULANCE", "crewMate"),
        qualifications: QUALIFICATIONS.filter((q) => p.qualifications.includes(q))
          .map((q) => QUALIFICATION_SHORT[q])
          .join(", "),
      };
    });
  // Names and straight-line distances between depots: the choices of a seat say how far a person comes from.
  const depotPlaces = input.depots ?? [];
  const crewDepots: CrewDepots = {
    names: Object.fromEntries([...depots].sort((a, b) => compareLabels(a.name, b.name)).map((d) => [d.id, d.name])),
    km: Object.fromEntries(
      depotPlaces.map((a) => [a.id, Object.fromEntries(depotPlaces.map((b) => [b.id, Math.round(depotDistanceKm(a, b))]))]),
    ),
  };

  const nameOf = (id: string) => {
    const p = context.people.get(id);
    return p ? staffName(p) : "?";
  };
  const ready = plan.crews.filter((c) => c.blocked === null).length;
  const parked = plan.crews.filter((c) => c.parked).length;
  const unavailable = plan.crews.filter((c) => c.unavailable).length;
  // An out-of-service vehicle is not « à revoir »: nobody can make it work that day.
  const blocked = plan.crews.length - ready - parked - unavailable;
  const hasSavedCrews = input.saved.length > 0;
  const fixedCount = rows.filter((r) => r.fixed !== null).length;
  const summary = [
    `${ready} véhicule${ready > 1 ? "s" : ""} avec équipage`,
    // A seat nobody fills, or hours over 6 hours without a legal break: the problems column says which.
    blocked > 0 ? `${blocked} non planifié${blocked > 1 ? "s" : ""} (équipage à revoir)` : null,
    unavailable > 0 ? `${unavailable} indisponible${unavailable > 1 ? "s" : ""}` : null,
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
        titleAside={<DayTabs current="/equipages" date={date} />}
        actions={<DayNav basePath="/equipages" date={date} tomorrow={tomorrow} keepParams={KEPT_PARAMS} fieldLabel="Date des équipages" />}
      />

      <div className="space-y-6">
        {locked ? <FormMessage tone="info">Équipages non modifiables&nbsp;: {locked}</FormMessage> : null}
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
          <Notice tone="warning" title={`Véhicules à revoir (${issues.length})`}>
            {issues.some((issue) => issue.changes.length > 0) ? (
              locked ? (
                // Re-planning is not possible now: say why instead of asking for it.
                <p>
                  Des tournées ont été calculées avant un changement de véhicule ou d&apos;équipage. {locked}
                  {date >= todayIso()
                    ? " Pour remplacer une personne sans réoptimiser\u00a0: planning, panneau du véhicule, «\u202fChanger l'équipage\u202f»."
                    : ""}{" "}
                  <Link href={`/planning?date=${date}`} className="font-medium underline">
                    Ouvrir le planning
                  </Link>
                </p>
              ) : (
                <p>
                  Des tournées ont été calculées avant un changement de véhicule ou d&apos;équipage&nbsp;: relancez
                  l&apos;optimisation depuis le{" "}
                  <Link href={`/planning?date=${date}`} className="font-medium underline">
                    planning
                  </Link>{" "}
                  pour appliquer les équipages ci-dessous.
                </p>
              )
            ) : null}
            {issues.some((issue) => issue.compliance.length > 0) ? (
              <p>Échéance dépassée&nbsp;: vérifiez le véhicule avant de le faire rouler.</p>
            ) : null}
            <ul className="list-disc space-y-0.5 pl-5">
              {issues.map((issue) => (
                <li key={issue.vehicleId}>
                  <span className="font-medium">{issue.label}</span>
                  {issue.hasRoute ? "" : " (sans tournée)"} — {[...issue.changes, ...issue.compliance].join("\u202f; ")}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <p className="text-sm text-slate-600">
          {fixedCount > 0
            ? `${fixedCount} équipage${fixedCount > 1 ? "s fixés" : " fixé"} pour ce jour, utilisé${fixedCount > 1 ? "s" : ""} tel${fixedCount > 1 ? "s" : ""} quel${fixedCount > 1 ? "s" : ""} par l'optimisation. Les autres véhicules ont leur`
            : "Chaque véhicule a son"}{" "}
          équipage attitré quand il est disponible, sinon un remplaçant qualifié&nbsp;: du même dépôt d&apos;abord, puis du
          dépôt le plus proche (Paramètres, «&#x202F;Équipages&#x202F;»), qui couvre l&apos;horaire du titulaire, en gardant les
          ambulanciers DE pour les ambulances. Modifiez une ligne pour la fixer, ou «&#x202F;Fixer cette proposition&#x202F;» pour
          garder le remplaçant proposé.
        </p>

        {/* Keyed by its date inside (crew-form.tsx): the seats of one day never show on the next. */}
        <CrewForm date={date} rows={rows} people={people} depots={crewDepots} locked={locked} hasSavedCrews={hasSavedCrews} />

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
                Les absences se saisissent dans la fiche de chaque chauffeur. Gardes et formations sont nommées ici&#x202F;; les
                autres motifs ne sont visibles que sur la fiche.
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={`Disponibles sans véhicule (${plan.idle.length})`} />
            <CardBody className="text-sm text-slate-700">
              {plan.idle.length === 0 ? (
                <p className="text-slate-500">Personne&nbsp;: tout le personnel disponible a un poste.</p>
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
