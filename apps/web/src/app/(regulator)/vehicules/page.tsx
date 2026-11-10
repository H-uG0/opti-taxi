import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import type { VehicleType } from "@prisma/client";
import type { ReactNode } from "react";
import { Badge, VehicleTypeBadge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { FilterBar, FilterSearch, FilterSelect } from "@/components/ui/filter-bar";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { GroupHeaderRow, TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { compareLabels, compareVehicles } from "@/lib/fleet/order";
import { ENERGY_LABELS, formatEuros, VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { loadDayCrewContext } from "@/lib/optimizer/build-request";
import { vehicleDay, type VehicleDay } from "@/lib/staff/day-status";
import { crewMemberName, crewQualificationErrors, otherSeats, seatsByPerson, sharedCrewWarning } from "./_lib/crew";
import { departmentLabel } from "./_lib/departments";
import {
  ALERT_FILTERS,
  ENERGIES,
  isFiltered,
  matchesVehicleFilter,
  parseVehicleFilter,
  STATUS_FILTERS,
  TOMORROW_FILTERS,
  VEHICLE_TYPES,
} from "./_lib/list-filter";
import { unavailabilityOn, unavailabilityText } from "@/lib/fleet/availability";
import { deadlineAlerts, deadlineName } from "@/lib/fleet/maintenance";
import { formatShortDate, fromIsoDate, todayIso, toIsoDate, tomorrowIso } from "@/lib/time";

export const metadata: Metadata = { title: "Véhicules" };

const TYPE_COUNT_LABELS: Record<VehicleType, [string, string]> = {
  TAXI: ["taxi", "taxis"],
  VSL: ["VSL", "VSL"],
  AMBULANCE: ["ambulance", "ambulances"],
};

const COLUMNS = 7;

const crewSelect = { select: { id: true, firstName: true, lastName: true, qualifications: true, active: true } } as const;

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const filter = parseVehicleFilter(await searchParams);

  const today = todayIso();
  const tomorrow = tomorrowIso();
  const [vehicles, odometers, depots, crews] = await Promise.all([
    db.vehicle.findMany({
      include: {
        defaultDriver: crewSelect,
        defaultCrewMate: crewSelect,
        depot: { select: { id: true, name: true, address: true } },
        maintenance: { where: { doneDate: null }, select: { kind: true, label: true, dueDate: true, dueKm: true, doneDate: true } },
        unavailabilities: {
          where: { endDate: { gte: fromIsoDate(today) }, startDate: { lte: fromIsoDate(today) } },
          select: { kind: true, startDate: true, endDate: true },
        },
      },
    }),
    db.fuelLog.groupBy({ by: ["vehicleId"], _max: { odometerKm: true } }),
    db.depot.findMany({ select: { id: true, name: true } }),
    // Tomorrow's crews, as on Équipages: who drives, a replacement, an outage, a vehicle left out.
    loadDayCrewContext(db, tomorrow),
  ]);
  const odometerOf = new Map(odometers.map((o) => [o.vehicleId, o._max.odometerKm ?? null]));
  const crewOf = new Map(crews.plan.crews.map((c) => [c.vehicleId, c]));
  const outages = crews.input.vehicleUnavailabilities ?? [];

  const active = vehicles.filter((v) => v.active);
  // Every active vehicle is loaded: enough to spot a person in the default crew of several of them.
  const seats = seatsByPerson(active);

  const rows = vehicles
    .map((vehicle) => {
      const todayOutages = vehicle.unavailabilities.map((u) => ({
        vehicleId: vehicle.id,
        kind: u.kind,
        startDate: toIsoDate(u.startDate),
        endDate: toIsoDate(u.endDate),
      }));
      const alerts = deadlineAlerts(
        vehicle.maintenance.map((d) => ({ ...d, dueDate: d.dueDate ? toIsoDate(d.dueDate) : null, doneDate: null })),
        today,
        odometerOf.get(vehicle.id) ?? null,
      );
      const isAmbulance = vehicle.type === "AMBULANCE";
      const qualificationProblem = Object.values(
        crewQualificationErrors(vehicle.type, vehicle.defaultDriver, isAmbulance ? vehicle.defaultCrewMate : null),
      ).join(" ");
      // Planning warnings only matter for vehicles offered to the optimisation.
      const driverShared =
        vehicle.active && vehicle.defaultDriver
          ? sharedCrewWarning(crewMemberName(vehicle.defaultDriver), otherSeats(seats, vehicle.defaultDriver.id, vehicle.id))
          : null;
      const crewMateShared =
        vehicle.active && isAmbulance && vehicle.defaultCrewMate
          ? sharedCrewWarning(crewMemberName(vehicle.defaultCrewMate), otherSeats(seats, vehicle.defaultCrewMate.id, vehicle.id))
          : null;
      const crew = crewOf.get(vehicle.id);
      return {
        vehicle,
        depotName: vehicle.depot.name,
        label: vehicle.label,
        type: vehicle.type,
        outToday: unavailabilityOn(vehicle.id, today, todayOutages),
        alerts,
        qualificationProblem,
        driverShared,
        crewMateShared,
        tomorrow: crew ? vehicleDay(crew, tomorrow, crews.people, outages) : null,
      };
    })
    // By depot, type and number; inactive vehicles after the active ones of their depot.
    .sort((a, b) => compareLabels(a.depotName, b.depotName) || Number(b.vehicle.active) - Number(a.vehicle.active) || compareVehicles(a, b));

  const visible = rows.filter((row) =>
    matchesVehicleFilter(
      {
        label: row.vehicle.label,
        registration: row.vehicle.registration,
        type: row.vehicle.type,
        energy: row.vehicle.energy,
        depotId: row.vehicle.depotId,
        active: row.vehicle.active,
        crewNames: [row.vehicle.defaultDriver, row.vehicle.defaultCrewMate].flatMap((p) => (p ? [crewMemberName(p)] : [])),
        overdueDeadlines: row.alerts.filter((a) => a.state.status === "overdue").length,
        soonDeadlines: row.alerts.filter((a) => a.state.status === "soon").length,
        crewProblem:
          row.vehicle.active &&
          (!row.vehicle.defaultDriver ||
            (row.vehicle.type === "AMBULANCE" && !row.vehicle.defaultCrewMate) ||
            row.qualificationProblem !== "" ||
            row.driverShared !== null ||
            row.crewMateShared !== null),
        tomorrow: row.vehicle.active ? row.tomorrow : null,
      },
      filter,
    ),
  );
  const groups = groupByDepot(visible);

  const activeAlerts = rows.filter((r) => r.vehicle.active).flatMap((r) => r.alerts);
  const overdue = activeAlerts.filter((a) => a.state.status === "overdue").length;
  const soon = activeAlerts.filter((a) => a.state.status === "soon").length;
  const inactiveCount = vehicles.length - active.length;
  const counts = (["TAXI", "VSL", "AMBULANCE"] as const)
    .map((type) => {
      const n = active.filter((v) => v.type === type).length;
      const [one, many] = TYPE_COUNT_LABELS[type];
      return n > 0 ? `${n} ${n > 1 ? many : one}` : null;
    })
    .filter(Boolean)
    .join(" · ");
  const filtered = isFiltered(filter);

  return (
    <>
      <PageHeader
        title="Véhicules"
        description={
          active.length > 0
            ? `${active.length} véhicule${active.length > 1 ? "s" : ""} actif${active.length > 1 ? "s" : ""} — ${counts}` +
              (overdue > 0 ? ` · ${overdue} échéance${overdue > 1 ? "s" : ""} dépassée${overdue > 1 ? "s" : ""}` : "") +
              (soon > 0 ? ` · ${soon} échéance${soon > 1 ? "s" : ""} sous 30 jours` : "")
            : "Flotte proposée à l'optimisation : type, capacité, dépôt, équipage et coût kilométrique."
        }
        actions={
          <LinkButton href="/vehicules/nouveau" variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouveau véhicule
          </LinkButton>
        }
      />

      {vehicles.length === 0 ? (
        <EmptyState
          title="Aucun véhicule"
          action={
            <LinkButton href="/vehicules/nouveau" variant="primary">
              Ajouter un véhicule
            </LinkButton>
          }
        >
          Ajoutez les taxis, VSL et ambulances de la flotte pour pouvoir optimiser les tournées.
        </EmptyState>
      ) : (
        <>
          <FilterBar action="/vehicules" label="Filtrer les véhicules" resetHref="/vehicules" filtered={filtered} className="mb-4">
            <FilterSearch defaultValue={filter.q} placeholder="Libellé, immatriculation, chauffeur" className="sm:w-64" />
            <FilterSelect
              name="depot"
              label="Dépôt"
              value={filter.depot ?? ""}
              allLabel="Tous les dépôts"
              options={[...depots].sort((a, b) => compareLabels(a.name, b.name)).map((d) => ({ value: d.id, label: d.name }))}
            />
            <FilterSelect
              name="type"
              label="Type"
              value={filter.type ?? ""}
              allLabel="Tous les types"
              options={VEHICLE_TYPES.map((t) => ({ value: t, label: VEHICLE_TYPE_SHORT[t] }))}
              className="w-36"
            />
            <FilterSelect
              name="energie"
              label="Énergie"
              value={filter.energy ?? ""}
              allLabel="Toutes"
              options={[...ENERGIES.map((e) => ({ value: e, label: ENERGY_LABELS[e] })), { value: "none", label: "Non renseignée" }]}
              className="w-36"
            />
            <FilterSelect
              name="alerte"
              label="Alertes"
              value={filter.alert ?? ""}
              allLabel="Sans filtre"
              options={Object.entries(ALERT_FILTERS).map(([value, label]) => ({ value, label }))}
              className="w-56"
            />
            <FilterSelect
              name="demain"
              label={`Demain (${formatShortDate(tomorrow).slice(0, 5)})`}
              value={filter.tomorrow ?? ""}
              allLabel="Tous"
              options={Object.entries(TOMORROW_FILTERS).map(([value, label]) => ({ value, label }))}
            />
            <FilterSelect
              name="statut"
              label="Statut"
              value={filter.status}
              defaultChoice="actifs"
              options={Object.entries(STATUS_FILTERS).map(([value, label]) => ({
                value,
                label: value === "inactifs" ? `${label} (${inactiveCount})` : label,
              }))}
              className="w-36"
            />
          </FilterBar>

          <p className="mb-2 text-sm text-slate-600" aria-live="polite">
            {filtered ? `${plural(visible.length, "véhicule affiché", "véhicules affichés")} sur ${vehicles.length}` : plural(visible.length, "véhicule", "véhicules")}
            , par dépôt, type et numéro.
          </p>

          {visible.length === 0 ? (
            <EmptyState title="Aucun véhicule ne correspond aux filtres" action={<LinkButton href="/vehicules">Réinitialiser les filtres</LinkButton>} />
          ) : (
            <Table stickyHeader>
              <caption className="sr-only">Véhicules par dépôt</caption>
              <THead>
                <tr>
                  <Th>Véhicule</Th>
                  <Th>Type</Th>
                  <Th title="Département de rattachement">Dépt</Th>
                  <Th>Équipage par défaut</Th>
                  <Th title={`Situation du ${formatShortDate(tomorrow)} (page Équipages)`}>Demain</Th>
                  <Th className="text-right whitespace-nowrap">Coût/km</Th>
                  <Th>Entretien</Th>
                </tr>
              </THead>
              <TBody>
                {groups.flatMap((group) => [
                  <GroupHeaderRow key={`depot-${group.id}`} colSpan={COLUMNS}>
                    <Link href={`/depots/${group.id}`} className="font-semibold tracking-wide text-slate-700 uppercase underline-offset-2 hover:underline">
                      Dépôt {group.name}
                    </Link>
                    <span className="ml-2">{plural(group.rows.length, "véhicule", "véhicules")}</span>
                  </GroupHeaderRow>,
                  ...group.rows.map(({ vehicle, alerts, outToday, qualificationProblem, driverShared, crewMateShared, tomorrow: day }) => {
                    const isAmbulance = vehicle.type === "AMBULANCE";
                    return (
                      <tr key={vehicle.id} className={vehicle.active ? "hover:bg-slate-50" : "bg-slate-50/60 text-slate-500"}>
                        <Td className="whitespace-nowrap">
                          <Link
                            href={`/vehicules/${vehicle.id}`}
                            className="font-medium text-slate-900 underline-offset-2 hover:text-brand-700 hover:underline"
                          >
                            {vehicle.label}
                          </Link>
                          {vehicle.active ? null : (
                            <span className="ml-2">
                              <Badge>Désactivé</Badge>
                            </span>
                          )}
                          <span className="block font-mono text-xs text-slate-500">{vehicle.registration}</span>
                        </Td>
                        <Td className="whitespace-nowrap">
                          <VehicleTypeBadge type={vehicle.type} />
                          <span className="block text-xs text-slate-500">
                            {plural(vehicle.capacity, "place", "places")}
                            {vehicle.energy ? ` · ${ENERGY_LABELS[vehicle.energy]}` : ""}
                          </span>
                        </Td>
                        <Td className="whitespace-nowrap" title={departmentLabel(vehicle.department)}>
                          {vehicle.department}
                        </Td>
                        <Td>
                          <div className="space-y-0.5">
                            {vehicle.defaultDriver ? (
                              <Link
                                href={`/chauffeurs/${vehicle.defaultDriver.id}`}
                                className="block underline-offset-2 hover:text-brand-700 hover:underline"
                              >
                                {crewMemberName(vehicle.defaultDriver)}
                              </Link>
                            ) : vehicle.active ? (
                              <Badge tone="warning">À affecter</Badge>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                            {isAmbulance ? (
                              vehicle.defaultCrewMate ? (
                                <p className="text-xs text-slate-500">
                                  Équipier :{" "}
                                  <Link
                                    href={`/chauffeurs/${vehicle.defaultCrewMate.id}`}
                                    className="underline-offset-2 hover:text-brand-700 hover:underline"
                                  >
                                    {crewMemberName(vehicle.defaultCrewMate)}
                                  </Link>
                                </p>
                              ) : vehicle.active ? (
                                <WarningBadge
                                  tone="warning"
                                  detail="Sans équipier par défaut, l'ambulance n'est planifiée que si un équipier qualifié reste libre ce jour-là (page Équipages)."
                                >
                                  Équipier à affecter
                                </WarningBadge>
                              ) : (
                                <p className="text-xs text-slate-500">Équipier : aucun</p>
                              )
                            ) : null}
                            {qualificationProblem ? (
                              <WarningBadge tone="danger" detail={qualificationProblem}>
                                Qualification manquante
                              </WarningBadge>
                            ) : null}
                            {driverShared ? (
                              <WarningBadge tone="warning" detail={driverShared}>
                                Chauffeur partagé
                              </WarningBadge>
                            ) : null}
                            {crewMateShared ? (
                              <WarningBadge tone="warning" detail={crewMateShared}>
                                Équipier partagé
                              </WarningBadge>
                            ) : null}
                          </div>
                        </Td>
                        <Td className="min-w-40">{vehicle.active ? <TomorrowCell day={day} /> : <span className="text-slate-400">—</span>}</Td>
                        <Td className="tabular text-right whitespace-nowrap">{formatEuros(vehicle.costPerKm)}</Td>
                        <Td>
                          <FleetNotesCell outToday={outToday} alerts={alerts} />
                        </Td>
                      </tr>
                    );
                  }),
                ])}
              </TBody>
            </Table>
          )}
        </>
      )}
    </>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}

type Row = { vehicle: { id: string; depotId: string; depot: { name: string } } };

function groupByDepot<T extends Row>(rows: readonly T[]): { id: string; name: string; rows: T[] }[] {
  const groups = new Map<string, { id: string; name: string; rows: T[] }>();
  for (const row of rows) {
    const group = groups.get(row.vehicle.depotId);
    if (group) group.rows.push(row);
    else groups.set(row.vehicle.depotId, { id: row.vehicle.depotId, name: row.vehicle.depot.name, rows: [row] });
  }
  return [...groups.values()];
}

/** Tomorrow's situation of a vehicle (crews of the day, Équipages). */
function TomorrowCell({ day }: { day: VehicleDay | null }) {
  if (!day) return <span className="text-slate-400">—</span>;
  switch (day.kind) {
    case "off":
      return (
        <WarningBadge tone="warning" detail={day.text}>
          Indisponible
        </WarningBadge>
      );
    case "parked":
      return <span className="text-xs text-slate-600">Laissé au dépôt</span>;
    case "missing":
      return (
        <WarningBadge tone="danger" detail={day.text}>
          Non planifié
        </WarningBadge>
      );
    case "crew":
      // The usual crew needs no name again: only a change is spelled out.
      return day.source === "default" ? (
        <span className="text-xs text-slate-500">Équipage attitré</span>
      ) : (
        <div className="text-xs leading-snug text-slate-700">
          <span className="block">{day.driver}</span>
          {day.crewMate ? <span className="block text-slate-500">avec {day.crewMate}</span> : null}
          {day.source === "replacement" ? <Badge tone="info">Remplaçant</Badge> : <span className="text-slate-500">Équipage fixé</span>}
        </div>
      );
  }
}

type OutageNote = ReturnType<typeof unavailabilityOn>;
type AlertNote = ReturnType<typeof deadlineAlerts>[number];

function FleetNotesCell({ outToday, alerts }: { outToday: OutageNote; alerts: AlertNote[] }) {
  if (!outToday && alerts.length === 0) return <span className="text-slate-400">—</span>;
  const more = alerts.length - 2;
  return (
    <div className="space-y-0.5">
      {outToday ? (
        <WarningBadge tone="danger" detail={unavailabilityText(outToday)}>
          Indisponible aujourd&apos;hui
        </WarningBadge>
      ) : null}
      {alerts.slice(0, 2).map(({ deadline, state }, i) => (
        <WarningBadge key={i} tone={state.status === "overdue" ? "danger" : "warning"} detail={`${deadlineName(deadline)} : ${state.text}`}>
          {deadlineName(deadline)}
        </WarningBadge>
      ))}
      {more > 0 ? <p className="text-xs text-slate-500">+ {plural(more, "autre échéance", "autres échéances")}</p> : null}
    </div>
  );
}

/** Badge on its own line; the explanation is in the tooltip and read by screen readers. */
function WarningBadge({ tone, detail, children }: { tone: BadgeTone; detail: string; children: ReactNode }) {
  return (
    <span className="block" title={detail}>
      <Badge tone={tone}>{children}</Badge>
      <span className="sr-only"> : {detail}</span>
    </span>
  );
}
