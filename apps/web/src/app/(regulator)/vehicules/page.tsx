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

  const [vehicles, inactiveCount] = await Promise.all([
    db.vehicle.findMany({
      where: showInactive ? {} : { active: true },
      orderBy: [{ active: "desc" }, { type: "asc" }, { label: "asc" }],
      include: { defaultDriver: crewSelect, defaultCrewMate: crewSelect },
    }),
    db.vehicle.count({ where: { active: false } }),
  ]);

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
            ? `${active.length} véhicule${active.length > 1 ? "s" : ""} actif${active.length > 1 ? "s" : ""} — ${counts}`
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
                    <span className="block truncate" title={vehicle.depotAddress}>
                      {vehicle.depotLabel}
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
                            detail="Sans équipier, l'ambulance n'est pas planifiée : elle part à deux."
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

/** Badge on its own line; the explanation is in the tooltip and read by screen readers. */
function WarningBadge({ tone, detail, children }: { tone: BadgeTone; detail: string; children: ReactNode }) {
  return (
    <span className="block" title={detail}>
      <Badge tone={tone}>{children}</Badge>
      <span className="sr-only"> : {detail}</span>
    </span>
  );
}
