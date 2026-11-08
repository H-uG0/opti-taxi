import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import type { VehicleType } from "@prisma/client";
import type { ReactNode } from "react";
import { Badge, VehicleTypeBadge, type BadgeTone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatEuros } from "@/lib/labels";
import { crewMemberName, crewQualificationErrors, otherSeats, seatsByPerson, sharedCrewWarning } from "./_lib/crew";
import { departmentLabel } from "./_lib/departments";
import { unavailabilityOn, unavailabilityText } from "@/lib/fleet/availability";
import { deadlineAlerts, deadlineName } from "@/lib/fleet/maintenance";
import { fromIsoDate, todayIso, toIsoDate, tomorrowIso } from "@/lib/time";

export const metadata: Metadata = { title: "Véhicules" };

const TYPE_COUNT_LABELS: Record<VehicleType, [string, string]> = {
  TAXI: ["taxi", "taxis"],
  VSL: ["VSL", "VSL"],
  AMBULANCE: ["ambulance", "ambulances"],
};

const crewSelect = { select: { id: true, firstName: true, lastName: true, qualifications: true, active: true } } as const;

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const { inactifs } = await searchParams;
  const showInactive = inactifs === "1";

  const today = todayIso();
  const tomorrow = tomorrowIso();
  const [vehicles, inactiveCount, odometers] = await Promise.all([
    db.vehicle.findMany({
      where: showInactive ? {} : { active: true },
      orderBy: [{ active: "desc" }, { type: "asc" }, { label: "asc" }],
      include: {
        defaultDriver: crewSelect,
        defaultCrewMate: crewSelect,
        depot: { select: { id: true, name: true, address: true } },
        maintenance: { where: { doneDate: null }, select: { kind: true, label: true, dueDate: true, dueKm: true, doneDate: true } },
        unavailabilities: {
          where: { endDate: { gte: fromIsoDate(today) }, startDate: { lte: fromIsoDate(tomorrow) } },
          select: { kind: true, startDate: true, endDate: true },
        },
      },
    }),
    db.vehicle.count({ where: { active: false } }),
    db.fuelLog.groupBy({ by: ["vehicleId"], _max: { odometerKm: true } }),
  ]);
  const odometerOf = new Map(odometers.map((o) => [o.vehicleId, o._max.odometerKm ?? null]));
  /** Out of service today or tomorrow, and the deadlines needing attention, per vehicle. */
  const fleetNotes = new Map(
    vehicles.map((v) => {
      const outages = v.unavailabilities.map((u) => ({
        vehicleId: v.id,
        kind: u.kind,
        startDate: toIsoDate(u.startDate),
        endDate: toIsoDate(u.endDate),
      }));
      const outToday = unavailabilityOn(v.id, today, outages);
      const outTomorrow = outToday ? null : unavailabilityOn(v.id, tomorrow, outages);
      const alerts = deadlineAlerts(
        v.maintenance.map((d) => ({ ...d, dueDate: d.dueDate ? toIsoDate(d.dueDate) : null, doneDate: null })),
        today,
        odometerOf.get(v.id) ?? null,
      );
      return [v.id, { outToday, outTomorrow, alerts }] as const;
    }),
  );
  const overdue = [...fleetNotes.values()].reduce((n, f) => n + f.alerts.filter((a) => a.state.status === "overdue").length, 0);
  const soon = [...fleetNotes.values()].reduce((n, f) => n + f.alerts.filter((a) => a.state.status === "soon").length, 0);

  const active = vehicles.filter((v) => v.active);
  // Every active vehicle is loaded (inactive ones only on demand): enough to
  // spot a person in the default crew of several of them.
  const seats = seatsByPerson(active);
  const counts = (["TAXI", "VSL", "AMBULANCE"] as const)
    .map((type) => {
      const n = active.filter((v) => v.type === type).length;
      const [one, many] = TYPE_COUNT_LABELS[type];
      return n > 0 ? `${n} ${n > 1 ? many : one}` : null;
    })
    .filter(Boolean)
    .join(" · ");

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
          <>
            {inactiveCount > 0 ? (
              <LinkButton href={showInactive ? "/vehicules" : "/vehicules?inactifs=1"} variant="ghost" size="sm">
                {showInactive ? "Masquer les désactivés" : `Afficher les désactivés (${inactiveCount})`}
              </LinkButton>
            ) : null}
            <LinkButton href="/vehicules/nouveau" variant="primary">
              <Plus aria-hidden className="size-4" />
              Nouveau véhicule
            </LinkButton>
          </>
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
        <Table>
          <THead>
            <tr>
              <Th>Libellé</Th>
              <Th>Immatriculation</Th>
              <Th>Type</Th>
              <Th className="text-right">Capacité</Th>
              <Th>Dépôt</Th>
              <Th>Département</Th>
              <Th>Chauffeur par défaut</Th>
              <Th className="text-right">Coût/km</Th>
              <Th>Entretien</Th>
              <Th>Statut</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {vehicles.map((vehicle) => {
              const crewProblems = crewQualificationErrors(
                vehicle.type,
                vehicle.defaultDriver,
                vehicle.type === "AMBULANCE" ? vehicle.defaultCrewMate : null,
              );
              const problemText = Object.values(crewProblems).join(" ");
              const isAmbulance = vehicle.type === "AMBULANCE";
              // Planning warnings only matter for vehicles offered to the optimisation.
              const driverShared =
                vehicle.active && vehicle.defaultDriver
                  ? sharedCrewWarning(
                      crewMemberName(vehicle.defaultDriver),
                      otherSeats(seats, vehicle.defaultDriver.id, vehicle.id),
                    )
                  : null;
              const crewMateShared =
                vehicle.active && isAmbulance && vehicle.defaultCrewMate
                  ? sharedCrewWarning(
                      crewMemberName(vehicle.defaultCrewMate),
                      otherSeats(seats, vehicle.defaultCrewMate.id, vehicle.id),
                    )
                  : null;
              return (
                <tr key={vehicle.id} className={vehicle.active ? "hover:bg-slate-50" : "bg-slate-50/60 text-slate-500"}>
                  <Td className="font-medium">
                    <Link
                      href={`/vehicules/${vehicle.id}`}
                      className="text-slate-900 underline-offset-2 hover:text-brand-700 hover:underline"
                    >
                      {vehicle.label}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs whitespace-nowrap">{vehicle.registration}</Td>
                  <Td>
                    <VehicleTypeBadge type={vehicle.type} />
                  </Td>
                  <Td className="tabular text-right">{vehicle.capacity}</Td>
                  <Td className="max-w-56">
                    <Link
                      href={`/depots/${vehicle.depot.id}`}
                      title={vehicle.depot.address}
                      className="block truncate underline-offset-2 hover:text-brand-700 hover:underline"
                    >
                      {vehicle.depot.name}
                    </Link>
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
                      {problemText ? (
                        <WarningBadge tone="danger" detail={problemText}>
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
                  <Td className="tabular text-right whitespace-nowrap">{formatEuros(vehicle.costPerKm)}</Td>
                  <Td>
                    <FleetNotesCell notes={fleetNotes.get(vehicle.id)} />
                  </Td>
                  <Td>{vehicle.active ? <Badge tone="success">Actif</Badge> : <Badge>Désactivé</Badge>}</Td>
                  <Td className="text-right">
                    <LinkButton
                      href={`/vehicules/${vehicle.id}`}
                      size="sm"
                      variant="ghost"
                      aria-label={`Modifier ${vehicle.label}`}
                    >
                      Modifier
                    </LinkButton>
                  </Td>
                </tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </>
  );
}

function FleetNotesCell({ notes }: { notes: { outToday: OutageNote; outTomorrow: OutageNote; alerts: AlertNote[] } | undefined }) {
  if (!notes || (!notes.outToday && !notes.outTomorrow && notes.alerts.length === 0)) {
    return <span className="text-slate-400">—</span>;
  }
  return (
    <div className="space-y-0.5">
      {notes.outToday ? (
        <WarningBadge tone="danger" detail={unavailabilityText(notes.outToday)}>
          Indisponible aujourd&apos;hui
        </WarningBadge>
      ) : null}
      {notes.outTomorrow ? (
        <WarningBadge tone="warning" detail={unavailabilityText(notes.outTomorrow)}>
          Indisponible demain
        </WarningBadge>
      ) : null}
      {notes.alerts.slice(0, 2).map(({ deadline, state }, i) => (
        <WarningBadge key={i} tone={state.status === "overdue" ? "danger" : "warning"} detail={`${deadlineName(deadline)} : ${state.text}`}>
          {deadlineName(deadline)}
        </WarningBadge>
      ))}
      {notes.alerts.length > 2 ? <p className="text-xs text-slate-500">+{notes.alerts.length - 2} échéance(s)</p> : null}
    </div>
  );
}

type OutageNote = ReturnType<typeof unavailabilityOn>;
type AlertNote = ReturnType<typeof deadlineAlerts>[number];

/** Badge on its own line; the explanation is in the tooltip and read by screen readers. */
function WarningBadge({ tone, detail, children }: { tone: BadgeTone; detail: string; children: ReactNode }) {
  return (
    <span className="block" title={detail}>
      <Badge tone={tone}>{children}</Badge>
      <span className="sr-only"> : {detail}</span>
    </span>
  );
}
