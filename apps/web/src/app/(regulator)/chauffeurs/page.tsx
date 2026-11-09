import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatEuros, QUALIFICATION_LABELS } from "@/lib/labels";
import { formatMinute, WEEKDAY_LABELS } from "@/lib/time";
import { plannedSeatCount } from "../vehicules/_lib/crew";
import { describeBreak, ISO_WEEKDAYS, QUALIFICATION_SHORT, QUALIFICATIONS } from "./schema";

export const metadata: Metadata = { title: "Chauffeurs" };

const DAY_LETTERS: Record<number, string> = { 1: "L", 2: "M", 3: "M", 4: "J", 5: "V", 6: "S", 7: "D" };

export default async function DriversPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("REGULATOR");
  const { inactifs } = await searchParams;
  const showInactive = inactifs === "1";

  const [drivers, inactiveCount] = await Promise.all([
    db.driver.findMany({
      where: showInactive ? {} : { active: true },
      orderBy: [{ active: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        qualifications: true,
        workDays: true,
        shiftStartMinute: true,
        shiftEndMinute: true,
        breakWindowStartMinute: true,
        breakWindowEndMinute: true,
        breakMinutes: true,
        hourlyCost: true,
        active: true,
        depot: { select: { id: true, name: true } },
        defaultForVehicles: { select: { id: true, label: true, active: true }, orderBy: { label: "asc" } },
        crewMateForVehicles: { select: { id: true, label: true, active: true, type: true }, orderBy: { label: "asc" } },
        // Never select passwordHash.
        user: { select: { email: true, active: true } },
      },
    }),
    db.driver.count({ where: { active: false } }),
  ]);

  const activeCount = drivers.filter((d) => d.active).length;

  return (
    <>
      <PageHeader
        title="Chauffeurs"
        description={
          activeCount > 0
            ? `${activeCount} chauffeur${activeCount > 1 ? "s" : ""} actif${activeCount > 1 ? "s" : ""} — qualifications, jours, horaires et pauses utilisés par l'optimiseur.`
            : "Qualifications, jours, horaires et pauses utilisés par l'optimiseur."
        }
        actions={
          <>
            {inactiveCount > 0 ? (
              <LinkButton href={showInactive ? "/chauffeurs" : "/chauffeurs?inactifs=1"} variant="ghost" size="sm">
                {showInactive ? "Masquer les désactivés" : `Afficher les désactivés (${inactiveCount})`}
              </LinkButton>
            ) : null}
            <LinkButton href="/chauffeurs/nouveau" variant="primary">
              <Plus aria-hidden className="size-4" />
              Nouveau chauffeur
            </LinkButton>
          </>
        }
      />

      {drivers.length === 0 ? (
        <EmptyState
          title="Aucun chauffeur"
          action={
            <LinkButton href="/chauffeurs/nouveau" variant="primary">
              Ajouter un chauffeur
            </LinkButton>
          }
        >
          Ajoutez les chauffeurs et ambulanciers avec leurs qualifications et horaires.
        </EmptyState>
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Nom</Th>
              <Th>Dépôt</Th>
              <Th>Qualifications</Th>
              <Th>Jours</Th>
              <Th>Horaires</Th>
              <Th>Pause</Th>
              <Th className="text-right">Coût horaire</Th>
              <Th>Véhicule par défaut</Th>
              <Th>Compte d&apos;accès</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {drivers.map((driver) => {
              const name = `${driver.lastName.toUpperCase()} ${driver.firstName}`;
              const breakText = describeBreak(driver);
              // A person works on one vehicle a day: the others get a replacement (crews of the day).
              const plannedSeats = plannedSeatCount(driver.defaultForVehicles, driver.crewMateForVehicles);
              const multiSeatText =
                driver.active && plannedSeats > 1
                  ? `Dans l'équipage par défaut de ${plannedSeats} véhicules actifs : ne roule que sur un par jour, les autres reçoivent un remplaçant s'il y en a un de libre (page Équipages).`
                  : null;
              return (
                <tr key={driver.id} className={driver.active ? "hover:bg-slate-50" : "bg-slate-50/60 text-slate-500"}>
                  <Td className="font-medium whitespace-nowrap">
                    <Link
                      href={`/chauffeurs/${driver.id}`}
                      className="text-slate-900 underline-offset-2 hover:text-brand-700 hover:underline"
                    >
                      {name}
                    </Link>
                    {driver.active ? null : (
                      <span className="ml-2">
                        <Badge>Désactivé</Badge>
                      </span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {driver.depot ? (
                      <Link href={`/depots/${driver.depot.id}`} className="underline-offset-2 hover:text-brand-700 hover:underline">
                        {driver.depot.name}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {QUALIFICATIONS.filter((q) => driver.qualifications.includes(q)).map((q) => (
                        <span key={q} title={QUALIFICATION_LABELS[q]}>
                          <Badge tone="brand">{QUALIFICATION_SHORT[q]}</Badge>
                        </span>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <span className="sr-only">
                      {driver.workDays.map((d) => WEEKDAY_LABELS[d]).join(", ") || "Aucun jour"}
                    </span>
                    <span aria-hidden className="flex gap-0.5 font-mono text-xs">
                      {ISO_WEEKDAYS.map((day) => {
                        const works = driver.workDays.includes(day);
                        return (
                          <span
                            key={day}
                            title={WEEKDAY_LABELS[day]}
                            className={cn(
                              "inline-flex size-5 items-center justify-center rounded-sm",
                              works ? "bg-brand-100 font-semibold text-brand-800" : "text-slate-300",
                            )}
                          >
                            {DAY_LETTERS[day]}
                          </span>
                        );
                      })}
                    </span>
                  </Td>
                  <Td className="tabular whitespace-nowrap">
                    {formatMinute(driver.shiftStartMinute)} – {formatMinute(driver.shiftEndMinute)}
                  </Td>
                  <Td className="tabular text-xs whitespace-nowrap">
                    {breakText ?? <span className="text-slate-400">Aucune</span>}
                  </Td>
                  <Td className="tabular text-right whitespace-nowrap">{formatEuros(driver.hourlyCost)}/h</Td>
                  <Td>
                    <VehicleLinks vehicles={driver.defaultForVehicles} />
                    {driver.crewMateForVehicles.length > 0 ? (
                      <p className="text-xs text-slate-500">
                        Équipier : <VehicleLinks vehicles={driver.crewMateForVehicles} inline />
                      </p>
                    ) : null}
                    {driver.defaultForVehicles.length === 0 && driver.crewMateForVehicles.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : null}
                    {multiSeatText ? (
                      <span className="block" title={multiSeatText}>
                        <Badge tone="warning">Plusieurs véhicules</Badge>
                        <span className="sr-only"> : {multiSeatText}</span>
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {driver.user ? (
                      <div className="space-y-0.5">
                        <p className="max-w-52 truncate text-xs" title={driver.user.email}>
                          {driver.user.email}
                        </p>
                        {driver.user.active ? <Badge tone="success">Actif</Badge> : <Badge>Désactivé</Badge>}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">Aucun compte</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <LinkButton href={`/chauffeurs/${driver.id}`} size="sm" variant="ghost" aria-label={`Modifier ${name}`}>
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

function VehicleLinks({
  vehicles,
  inline = false,
}: {
  vehicles: { id: string; label: string; active: boolean }[];
  inline?: boolean;
}) {
  if (vehicles.length === 0) return null;
  const links = vehicles.map((vehicle, index) => (
    <span key={vehicle.id}>
      {index > 0 ? ", " : null}
      <Link
        href={`/vehicules/${vehicle.id}`}
        className={cn("underline-offset-2 hover:text-brand-700 hover:underline", !vehicle.active && "text-slate-400 line-through")}
        title={vehicle.active ? undefined : "Véhicule désactivé"}
      >
        {vehicle.label}
      </Link>
    </span>
  ));
  return inline ? <>{links}</> : <p>{links}</p>;
}
