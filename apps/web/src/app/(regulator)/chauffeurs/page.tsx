import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { FilterBar, FilterSearch, FilterSelect } from "@/components/ui/filter-bar";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { GroupHeaderRow, TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { compareLabels, comparePeople } from "@/lib/fleet/order";
import { formatEuros, QUALIFICATION_LABELS } from "@/lib/labels";
import { loadDayCrewContext } from "@/lib/optimizer/build-request";
import { peopleDay, type PersonDay } from "@/lib/staff/day-status";
import { workTimeSummary } from "@/lib/staff/work-time";
import { formatMinute, formatShortDate, tomorrowIso, WEEKDAY_LABELS } from "@/lib/time";
import { plannedSeatCount } from "../vehicules/_lib/crew";
import {
  ALERT_FILTERS,
  isFiltered,
  matchesDriverFilter,
  NO_DEPOT,
  parseDriverFilter,
  STATUS_FILTERS,
  TOMORROW_FILTERS,
} from "./list-filter";
import { describeBreak, ISO_WEEKDAYS, QUALIFICATION_SHORT, QUALIFICATIONS } from "./schema";

export const metadata: Metadata = { title: "Chauffeurs" };

const DAY_LETTERS: Record<number, string> = { 1: "L", 2: "M", 3: "M", 4: "J", 5: "V", 6: "S", 7: "D" };

/** The « Jours » column from 1 440 px; below, the days are shown under the hours (the table fits at 1 280 px). */
const WIDE_ONLY = "hidden min-[1440px]:table-cell";
const COLUMNS = 8;

export default async function DriversPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const filter = parseDriverFilter(await searchParams);
  const tomorrow = tomorrowIso();

  const [drivers, depots, crews] = await Promise.all([
    db.driver.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        qualifications: true,
        workDays: true,
        shiftStartMinute: true,
        shiftEndMinute: true,
        breakWindowStartMinute: true,
        breakWindowEndMinute: true,
        breakMinutes: true,
        hourlyCost: true,
        active: true,
        depotId: true,
        depot: { select: { id: true, name: true } },
        defaultForVehicles: { select: { id: true, label: true, active: true, type: true } },
        crewMateForVehicles: { select: { id: true, label: true, active: true, type: true } },
        // Never select passwordHash.
        user: { select: { email: true, active: true } },
      },
    }),
    db.depot.findMany({ select: { id: true, name: true } }),
    // Tomorrow's crews, as on Équipages: who is absent, on which vehicle, or free.
    loadDayCrewContext(db, tomorrow),
    // Everyone's absences of tomorrow are on screen (what the planning may say: never a private reason).
    auditRead(user, { action: "staff_list.view", entity: "Driver", entityId: null, serviceDate: tomorrow }),
  ]);
  const days = peopleDay(crews.plan, crews.input.people, crews.input.absences);
  const vehicleLabels = new Map(crews.input.vehicles.map((v) => [v.id, v.label]));

  const rows = drivers
    .map((driver) => {
      const plannedSeats = plannedSeatCount(driver.defaultForVehicles, driver.crewMateForVehicles);
      // Over 6 hours without a legal break, the vehicle they drive is left out of the planning (lib/staff/work-time.ts).
      const workTime = driver.active ? workTimeSummary(driver, { start: driver.shiftStartMinute, end: driver.shiftEndMinute }) : null;
      return {
        driver,
        depotName: driver.depot?.name ?? null,
        multiSeat: driver.active && plannedSeats > 1 ? plannedSeats : 0,
        workTime,
        tomorrow: days.get(driver.id) ?? null,
      };
    })
    // By depot (people without a depot last), active first, then by name.
    .sort(
      (a, b) =>
        Number(a.depotName === null) - Number(b.depotName === null) ||
        compareLabels(a.depotName ?? "", b.depotName ?? "") ||
        Number(b.driver.active) - Number(a.driver.active) ||
        comparePeople(a.driver, b.driver),
    );
  const visible = rows.filter((row) =>
    matchesDriverFilter(
      {
        firstName: row.driver.firstName,
        lastName: row.driver.lastName,
        email: row.driver.user?.email ?? null,
        phone: row.driver.phone,
        depotId: row.driver.depotId,
        qualifications: row.driver.qualifications,
        active: row.driver.active,
        breakToFix: row.workTime !== null,
        multiSeat: row.multiSeat > 0,
        hasActiveAccount: row.driver.user?.active === true,
        tomorrow: row.driver.active ? row.tomorrow : null,
      },
      filter,
    ),
  );
  const groups: { id: string; name: string | null; rows: typeof visible }[] = [];
  for (const row of visible) {
    const id = row.driver.depotId ?? NO_DEPOT;
    const last = groups.at(-1);
    if (last && last.id === id) last.rows.push(row);
    else groups.push({ id, name: row.depotName, rows: [row] });
  }

  const activeCount = drivers.filter((d) => d.active).length;
  const inactiveCount = drivers.length - activeCount;
  const absentTomorrow = rows.filter((r) => r.driver.active && r.tomorrow?.kind === "absent").length;
  const filtered = isFiltered(filter);
  const tomorrowShort = formatShortDate(tomorrow).slice(0, 5);

  return (
    <>
      <PageHeader
        title="Chauffeurs"
        description={
          activeCount > 0
            ? `${activeCount} personne${activeCount > 1 ? "s" : ""} active${activeCount > 1 ? "s" : ""}${absentTomorrow > 0 ? ` · ${absentTomorrow} absente${absentTomorrow > 1 ? "s" : ""} demain` : ""} — qualifications, jours, horaires et pauses utilisés par l'optimiseur.`
            : "Qualifications, jours, horaires et pauses utilisés par l'optimiseur."
        }
        actions={
          <LinkButton href="/chauffeurs/nouveau" variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouveau chauffeur
          </LinkButton>
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
        <>
          <FilterBar action="/chauffeurs" label="Filtrer le personnel" resetHref="/chauffeurs" filtered={filtered} className="mb-4">
            <FilterSearch defaultValue={filter.q} placeholder="Nom, e-mail ou téléphone" className="sm:w-64" />
            <FilterSelect
              name="depot"
              label="Dépôt"
              value={filter.depot ?? ""}
              allLabel="Tous les dépôts"
              options={[
                ...[...depots].sort((a, b) => compareLabels(a.name, b.name)).map((d) => ({ value: d.id, label: d.name })),
                { value: NO_DEPOT, label: "Sans dépôt" },
              ]}
            />
            <FilterSelect
              name="qualification"
              label="Qualification"
              value={filter.qualification ?? ""}
              allLabel="Toutes"
              options={QUALIFICATIONS.map((q) => ({ value: q, label: QUALIFICATION_LABELS[q] }))}
              className="w-52"
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
              label={`Demain (${tomorrowShort})`}
              value={filter.tomorrow ?? ""}
              allLabel="Tous"
              options={Object.entries(TOMORROW_FILTERS).map(([value, label]) => ({ value, label }))}
              className="w-56"
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
            {/* Out of the people of the status chosen (active by default, as the header counts them). */}
            {filtered
              ? `${plural(visible.length, "personne affichée", "personnes affichées")} sur ${
                  filter.status === "actifs"
                    ? plural(activeCount, "active", "actives")
                    : filter.status === "inactifs"
                      ? plural(inactiveCount, "désactivée", "désactivées")
                      : drivers.length
                }`
              : plural(visible.length, "personne", "personnes")}
            , par dépôt et par nom.
          </p>

          {visible.length === 0 ? (
            <EmptyState
              title="Personne ne correspond aux filtres"
              action={<LinkButton href="/chauffeurs">Réinitialiser les filtres</LinkButton>}
            />
          ) : (
            <Table stickyHeader>
              <caption className="sr-only">Personnel par dépôt</caption>
              <THead>
                <tr>
                  <Th>Nom</Th>
                  <Th>Qualifications</Th>
                  <Th className={WIDE_ONLY}>Jours</Th>
                  <Th>
                    <span className="min-[1440px]:hidden">Jours, horaires et pause</span>
                    <span className="hidden min-[1440px]:inline">Horaires et pause</span>
                  </Th>
                  <Th title={`Situation du ${formatShortDate(tomorrow)} (page Équipages)`}>Demain</Th>
                  <Th>Véhicule par défaut</Th>
                  <Th>Compte</Th>
                  <Th className="hidden text-right whitespace-nowrap 2xl:table-cell">Coût/h</Th>
                </tr>
              </THead>
              <TBody>
                {groups.flatMap((group) => [
                  <GroupHeaderRow key={`depot-${group.id}`} colSpan={COLUMNS}>
                    {group.name ? (
                      <Link href={`/depots/${group.id}`} className="font-semibold tracking-wide text-slate-700 uppercase underline-offset-2 hover:underline">
                        Dépôt {group.name}
                      </Link>
                    ) : (
                      <span className="font-semibold tracking-wide text-slate-700 uppercase">Sans dépôt</span>
                    )}
                    <span className="ml-2">{plural(group.rows.length, "personne", "personnes")}</span>
                  </GroupHeaderRow>,
                  ...group.rows.map(({ driver, multiSeat, workTime, tomorrow: day }) => {
                    const name = `${driver.lastName.toUpperCase()} ${driver.firstName}`;
                    const breakText = describeBreak(driver);
                    const multiSeatText =
                      multiSeat > 1
                        ? `Dans l'équipage par défaut de ${multiSeat} véhicules actifs : ne roule que sur un par jour, les autres reçoivent un remplaçant s'il y en a un de libre (page Équipages).`
                        : null;
                    const workTimeText = workTime
                      ? `${workTime} : le véhicule qu'il conduit n'est pas planifié tant que la pause n'est pas réglée sur sa fiche.`
                      : null;
                    return (
                      <tr key={driver.id} className={driver.active ? "hover:bg-slate-50" : "bg-slate-50/60 text-slate-500"}>
                        <Td className="whitespace-nowrap">
                          <Link
                            href={`/chauffeurs/${driver.id}`}
                            className="font-medium text-slate-900 underline-offset-2 hover:text-brand-700 hover:underline"
                          >
                            {name}
                          </Link>
                          {driver.active ? null : (
                            <span className="ml-2">
                              <Badge>Désactivé</Badge>
                            </span>
                          )}
                          {driver.phone ? (
                            <a
                              href={`tel:${driver.phone.replace(/[^\d+]/g, "")}`}
                              className="tabular block text-xs text-slate-500 underline-offset-2 hover:text-brand-700 hover:underline"
                            >
                              {driver.phone}
                            </a>
                          ) : null}
                        </Td>
                        <Td className="max-w-40">
                          <div className="flex flex-wrap gap-1">
                            {QUALIFICATIONS.filter((q) => driver.qualifications.includes(q)).map((q) => (
                              <span key={q} title={QUALIFICATION_LABELS[q]}>
                                <Badge tone="brand">{QUALIFICATION_SHORT[q]}</Badge>
                              </span>
                            ))}
                          </div>
                        </Td>
                        <Td className={WIDE_ONLY}>
                          <WorkDays days={driver.workDays} />
                        </Td>
                        <Td className="tabular whitespace-nowrap">
                          {/* Under 1 440 px the days go under the hours: the table fits at 1 280 px. */}
                          <WorkDays days={driver.workDays} className="mb-1 min-[1440px]:hidden" />
                          {formatMinute(driver.shiftStartMinute)} – {formatMinute(driver.shiftEndMinute)}
                          <span className="block text-xs text-slate-500">{breakText ? `Pause ${breakText.replace(/ entre (\S+) et (\S+)$/, ", $1–$2")}` : "Sans pause"}</span>
                          {workTimeText ? (
                            <span className="block" title={workTimeText}>
                              <Badge tone="warning">Pause à régler</Badge>
                              <span className="sr-only"> : {workTimeText}</span>
                            </span>
                          ) : null}
                        </Td>
                        <Td className="min-w-28">
                          {driver.active ? (
                            <TomorrowCell
                              day={day}
                              labels={vehicleLabels}
                              usual={[...driver.defaultForVehicles, ...driver.crewMateForVehicles].map((v) => v.id)}
                              tomorrow={tomorrow}
                            />
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </Td>
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
                        <Td className="whitespace-nowrap">
                          {driver.user ? (
                            // The e-mail on hover and for screen readers: the column stays narrow.
                            <span title={driver.user.email}>
                              {driver.user.active ? <Badge tone="success">Actif</Badge> : <Badge>Désactivé</Badge>}
                              <span className="sr-only"> : {driver.user.email}</span>
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">Aucun</span>
                          )}
                        </Td>
                        {/* From 1 536 px; it is on the person's sheet. */}
                        <Td className="tabular hidden text-right whitespace-nowrap 2xl:table-cell">{formatEuros(driver.hourlyCost)}</Td>
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

/** The working days of a person: one letter per day, the days worked highlighted (named for screen readers). */
function WorkDays({ days, className }: { days: readonly number[]; className?: string }) {
  return (
    <span className={cn("block", className)}>
      <span className="sr-only">{days.map((d) => WEEKDAY_LABELS[d]).join(", ") || "Aucun jour"}</span>
      <span aria-hidden className="flex gap-0.5 font-mono text-xs">
        {ISO_WEEKDAYS.map((weekday) => {
          const works = days.includes(weekday);
          return (
            <span
              key={weekday}
              title={WEEKDAY_LABELS[weekday]}
              className={cn(
                "inline-flex size-4.5 items-center justify-center rounded-sm text-[11px]",
                works ? "bg-brand-100 font-semibold text-brand-800" : "text-slate-300",
              )}
            >
              {DAY_LETTERS[weekday]}
            </span>
          );
        })}
      </span>
    </span>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}

/** Tomorrow's situation of a person (crews of the day, Équipages): never the private reason of an absence. */
function TomorrowCell({
  day,
  labels,
  usual,
  tomorrow,
}: {
  day: PersonDay | null;
  labels: ReadonlyMap<string, string>;
  usual: readonly string[];
  tomorrow: string;
}) {
  if (!day) return <span className="text-slate-400">—</span>;
  switch (day.kind) {
    case "inactive":
      return <span className="text-slate-400">—</span>;
    case "absent":
      // The column is tomorrow: only the word, and the last day when it goes on after.
      return (
        <span className="block text-xs font-medium text-amber-800" title={day.text}>
          {day.label}
          {day.endDate > tomorrow ? <span className="font-normal"> jusqu&apos;au {formatShortDate(day.endDate).slice(0, 5)}</span> : null}
        </span>
      );
    case "rest":
      return <span className="text-xs text-slate-500">Repos</span>;
    case "free":
      return <Badge tone="info">Disponible</Badge>;
    case "vehicle":
      // On a vehicle of their default crew: the next column already names it.
      if (usual.includes(day.vehicleId) && !day.replacement) {
        return <span className="text-xs text-slate-500">{day.seat === "crewMate" ? "Son ambulance (équipier)" : "Son véhicule"}</span>;
      }
      return (
        <div className="text-xs leading-snug text-slate-700">
          <Link href={`/vehicules/${day.vehicleId}`} className="underline-offset-2 hover:text-brand-700 hover:underline">
            {labels.get(day.vehicleId) ?? "Véhicule"}
          </Link>
          {day.seat === "crewMate" ? <span className="text-slate-500"> (équipier)</span> : null}
          {day.replacement ? (
            <span className="block">
              <Badge tone="info">Remplaçant</Badge>
            </span>
          ) : null}
        </div>
      );
  }
}

function VehicleLinks({
  vehicles,
  inline = false,
}: {
  vehicles: { id: string; label: string; active: boolean }[];
  inline?: boolean;
}) {
  if (vehicles.length === 0) return null;
  const links = [...vehicles].sort((a, b) => compareLabels(a.label, b.label)).map((vehicle, index) => (
    <span key={vehicle.id}>
      {index > 0 ? ", " : null}
      <Link
        href={`/vehicules/${vehicle.id}`}
        className={cn("whitespace-nowrap underline-offset-2 hover:text-brand-700 hover:underline", !vehicle.active && "text-slate-400 line-through")}
        title={vehicle.active ? undefined : "Véhicule désactivé"}
      >
        {vehicle.label}
      </Link>
    </span>
  ));
  return inline ? <>{links}</> : <p>{links}</p>;
}
