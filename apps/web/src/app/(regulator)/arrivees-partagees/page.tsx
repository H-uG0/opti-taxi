import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Building2, Info, Phone, Printer, TriangleAlert } from "lucide-react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TBody, Td, THead, Th } from "@/components/ui/table";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatAddress, isShareable } from "@/lib/domain/rules";
import { FACILITY_TYPE_LABELS } from "@/lib/labels";
import { formatLongDate, formatMinute, fromIsoDate, isIsoDate, tomorrowIso } from "@/lib/time";
import { DayNav } from "../courses/day-nav";
import { coPassengersFromStops, coursesHref, EMPTY_FILTERS, patientDisplayName, plural } from "../courses/trip-list";
import {
  countPatients,
  groupSharedTransports,
  parseFacilityFilter,
  sharedArrivalsHref,
  type SharedTransportTrip,
  type TransportGroup,
} from "./grouping";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Arrivées partagées" };

/**
 * The regulator shell (sidebar, top bar) is not printed (print:hidden in the
 * layout). The full list is an internal regulation document (patients of every
 * facility); what goes to a reception desk is the sheet of its own facility
 * (?etablissement=), so no other facility's patients are disclosed.
 */
const PRINT_CSS = `@media print {
  body { background: #fff !important; }
  @page { margin: 12mm; }
}`;

export default async function SharedArrivalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const date = isIsoDate(rawDate) ? rawDate : tomorrowIso();
  const facilityFilter = parseFacilityFilter(params.etablissement);
  const serviceDate = fromIsoDate(date);

  // Every trip in a route is read: whether it is shared comes from the stops
  // (co-passengers on board), not from the stored flag (see groupSharedTransports).
  const [trips, stops, routeCount] = await Promise.all([
    db.trip.findMany({
      where: {
        serviceDate,
        routeId: { not: null },
        facilityId: facilityFilter ?? { not: null },
        status: { notIn: ["CANCELLED", "NO_SHOW"] },
      },
      select: {
        id: true,
        direction: true,
        plannedPickupMinute: true,
        plannedDropoffMinute: true,
        appointmentMinute: true,
        readyMinute: true,
        sharingAllowed: true,
        sharingStatus: true,
        patient: { select: { firstName: true, lastName: true } },
        facility: {
          select: { id: true, name: true, type: true, phone: true, address: true, postalCode: true, city: true },
        },
        route: {
          select: {
            status: true,
            vehicle: { select: { id: true, label: true, type: true } },
            driver: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    // A cancelled or absent patient is not on board: not a co-passenger.
    db.routeStop.findMany({
      where: { route: { serviceDate }, trip: { status: { notIn: ["CANCELLED", "NO_SHOW"] } } },
      select: { routeId: true, tripId: true, kind: true, sequence: true },
    }),
    db.route.count({ where: { serviceDate } }),
    // Trace of the read (patients' names and care facilities of the day); never breaks the page.
    // A facility's sheet (handed to its reception desk) names that facility.
    auditRead(
      user,
      facilityFilter
        ? { action: "shared_arrivals.view", entity: "Facility", entityId: facilityFilter, serviceDate: date }
        : { action: "shared_arrivals.view", entity: "Trip", entityId: null, serviceDate: date },
    ),
  ]);

  const coPassengers = coPassengersFromStops(stops);
  const shared: SharedTransportTrip[] = trips.map((trip) => ({
    id: trip.id,
    direction: trip.direction,
    patientName: patientDisplayName(trip.patient),
    facility: trip.facility
      ? {
          id: trip.facility.id,
          name: trip.facility.name,
          type: trip.facility.type,
          phone: trip.facility.phone,
          address: formatAddress(trip.facility),
        }
      : null,
    vehicle: trip.route?.vehicle ?? null,
    driverName: trip.route?.driver ? `${trip.route.driver.firstName} ${trip.route.driver.lastName}` : null,
    routeValidated: trip.route?.status === "VALIDATED",
    plannedPickupMinute: trip.plannedPickupMinute,
    plannedDropoffMinute: trip.plannedDropoffMinute,
    appointmentMinute: trip.appointmentMinute,
    readyMinute: trip.readyMinute,
    coPassengerIds: coPassengers.get(trip.id) ?? [],
    sharingRefused: !isShareable(trip),
  }));

  const facilities = groupSharedTransports(shared);
  const counts = countPatients(facilities);
  const unvalidated = facilities.some((f) =>
    [...f.arrivals, ...f.departures].some((group) => !group.routeValidated),
  );
  const longDate = formatLongDate(date);
  const sheet = facilityFilter ? (facilities[0] ?? null) : null;

  return (
    <div>
      <style>{PRINT_CSS}</style>
      <PageHeader
        title={sheet ? `Transports partagés · ${sheet.facility.name}` : "Arrivées partagées"}
        description={
          facilityFilter
            ? `Fiche pour l'accueil de l'établissement · ${longDate}`
            : `Transports partagés du ${longDate}, par lieu de soins`
        }
        actions={
          facilityFilter || facilities.length > 0 ? (
            <>
              {facilityFilter ? (
                <LinkButton href={sharedArrivalsHref(date)} variant="ghost" className="print:hidden">
                  <ArrowLeft aria-hidden className="size-4" />
                  Tous les établissements
                </LinkButton>
              ) : null}
              {facilities.length > 0 ? (
                facilityFilter ? (
                  <PrintButton label="Imprimer la fiche" title="Fiche à transmettre à l'accueil de cet établissement" />
                ) : (
                  <PrintButton
                    label="Imprimer la liste interne"
                    title="Document interne : il contient les patients de tous les établissements. Pour un accueil, imprimez sa fiche."
                  />
                )
              ) : null}
            </>
          ) : null
        }
      />

      {facilities.length > 0 && !facilityFilter ? (
        <p className="mb-3 hidden rounded-md border border-slate-400 px-3 py-2 text-sm font-semibold text-slate-900 print:block">
          Document interne à la régulation : il contient les patients de plusieurs établissements (données de santé). Ne
          pas le transmettre à un accueil : imprimez la fiche de chaque établissement.
        </p>
      ) : null}

      <p className="mb-4 flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 print:border-slate-300 print:bg-white">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Le transporteur prévient l&apos;accueil du lieu de soins d&apos;un transport partagé (décret 2025-202, art.
          R. 322-11-7). Les patients d&apos;un même véhicule arrivent ou repartent ensemble.
          {facilityFilter ? null : (
            <span className="print:hidden">
              {" "}
              Chaque accueil ne reçoit que la fiche de son établissement (bouton « Fiche pour l&apos;accueil »).
            </span>
          )}
        </span>
      </p>

      <DayNav
        key={date}
        basePath="/arrivees-partagees"
        date={date}
        params={facilityFilter ? { etablissement: facilityFilter } : {}}
        className="mb-5 print:hidden"
      />

      {facilities.length === 0 ? (
        facilityFilter ? (
          <EmptyState
            title={`Aucun transport partagé pour cet établissement le ${longDate}`}
            action={
              <LinkButton href={sharedArrivalsHref(date)} variant="secondary">
                Tous les établissements
              </LinkButton>
            }
          >
            Il n&apos;y a pas d&apos;accueil à prévenir pour ce lieu de soins ce jour-là.
          </EmptyState>
        ) : (
          <EmptyState
            title={
              routeCount === 0
                ? `Le planning du ${longDate} n'est pas encore construit`
                : `Aucun transport partagé le ${longDate}`
            }
            action={
              <LinkButton href={`/planning?date=${date}`} variant="secondary">
                Ouvrir le planning
              </LinkButton>
            }
          >
            {routeCount === 0
              ? "Optimisez la journée : les transports partagés apparaîtront ici, établissement par établissement."
              : "Aucune course n'est partagée dans les tournées de ce jour : il n'y a pas d'accueil à prévenir."}
          </EmptyState>
        )
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-600">
            {facilityFilter ? "" : `${plural(facilities.length, "établissement", "établissements")} à prévenir · `}
            {plural(counts.arrivals, "arrivée", "arrivées")} · {plural(counts.departures, "départ", "départs")} en transport
            partagé
          </p>
          {counts.refused > 0 ? (
            <p
              role="note"
              className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 print:hidden"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                {counts.refused > 1
                  ? `${counts.refused} patients figurent ici alors qu'ils ont refusé le transport partagé.`
                  : "Un patient figure ici alors qu'il a refusé le transport partagé."}{" "}
                Réoptimisez le planning avant de prévenir l&apos;accueil.{" "}
                <Link
                  href={coursesHref(date, { ...EMPTY_FILTERS, sharing: "REFUSED" })}
                  className="font-medium underline underline-offset-2"
                >
                  Voir les refus
                </Link>
              </span>
            </p>
          ) : null}
          {unvalidated ? (
            <p className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 print:hidden">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                Certaines tournées ne sont pas encore validées : la liste peut changer.{" "}
                <Link href={`/planning?date=${date}`} className="font-medium underline underline-offset-2">
                  Valider le planning
                </Link>
              </span>
            </p>
          ) : null}

          <div className="space-y-5">
            {facilities.map(({ facility, arrivals, departures }) => (
              <Card key={facility.id} className="break-inside-avoid print:shadow-none">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                      <Building2 aria-hidden className="size-4 text-slate-500 print:hidden" />
                      {facility.name}
                    </h2>
                    <p className="text-sm text-slate-600">
                      {FACILITY_TYPE_LABELS[facility.type]} · {facility.address}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {facility.phone ? (
                      <a
                        href={`tel:${facility.phone.replace(/\s+/g, "")}`}
                        className="tabular inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
                      >
                        <Phone aria-hidden className="size-4 text-brand-700" />
                        Accueil : {facility.phone}
                      </a>
                    ) : (
                      <p className="inline-flex items-center gap-1.5 text-sm text-amber-800">
                        <TriangleAlert aria-hidden className="size-4" />
                        Téléphone de l&apos;accueil non renseigné
                        <Link href="/etablissements" className="font-medium underline underline-offset-2 print:hidden">
                          Compléter
                        </Link>
                      </p>
                    )}
                    {facilityFilter ? null : (
                      <LinkButton
                        href={sharedArrivalsHref(date, facility.id)}
                        size="sm"
                        className="print:hidden"
                        aria-label={`Fiche pour l'accueil de ${facility.name} (seulement ses patients, à imprimer)`}
                      >
                        <Printer aria-hidden className="size-4" />
                        Fiche pour l&apos;accueil
                      </LinkButton>
                    )}
                  </div>
                </div>
                <div className="space-y-4 p-4">
                  {arrivals.length > 0 ? (
                    <GroupTable
                      title="Arrivées (aller)"
                      timeHeader="Arrivée prévue"
                      referenceLabel="RDV"
                      plannedLabel="arrivée"
                      groups={arrivals}
                    />
                  ) : null}
                  {departures.length > 0 ? (
                    <GroupTable
                      title="Départs (retour)"
                      timeHeader="Prise en charge prévue"
                      referenceLabel="fin de séance"
                      plannedLabel="prise en charge"
                      groups={departures}
                    />
                  ) : null}
                  <p className="hidden pt-2 text-sm text-slate-700 print:block">
                    Accueil prévenu le ____ / ____ à ____ h ____ par ______________________
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function GroupTable({
  title,
  timeHeader,
  referenceLabel,
  plannedLabel,
  groups,
}: {
  title: string;
  timeHeader: string;
  referenceLabel: string;
  plannedLabel: string;
  groups: TransportGroup[];
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <Table>
        <THead>
          <tr>
            <Th className="w-32">{timeHeader}</Th>
            <Th className="w-64">Véhicule · chauffeur</Th>
            <Th>Patients transportés ensemble</Th>
          </tr>
        </THead>
        <TBody>
          {groups.map((group) => (
            <tr key={group.key} className="align-top">
              <Td className="tabular text-base font-semibold whitespace-nowrap">{formatMinute(group.minute)}</Td>
              <Td>
                {group.vehicle ? (
                  <span className="flex flex-wrap items-center gap-1.5 font-medium text-slate-900">
                    {group.vehicle.label}
                    <VehicleTypeBadge type={group.vehicle.type} />
                  </span>
                ) : (
                  <span className="text-slate-500">Véhicule non affecté</span>
                )}
                <span className="block text-xs text-slate-600">{group.driverName ?? "Chauffeur non affecté"}</span>
                {group.vehicle && !group.routeValidated ? (
                  <span className="mt-1 inline-block print:hidden">
                    <Badge tone="warning">Tournée non validée</Badge>
                  </span>
                ) : null}
              </Td>
              <Td>
                <ul className="space-y-1">
                  {group.patients.map((patient) => (
                    <li key={patient.tripId}>
                      <span className="font-medium text-slate-900">{patient.patientName}</span>{" "}
                      <span className="tabular text-xs text-slate-600">
                        {plannedLabel} {formatMinute(patient.plannedMinute)} · {referenceLabel}{" "}
                        {formatMinute(patient.referenceMinute)}
                      </span>
                      {patient.sharingRefused ? (
                        <span className="ml-1.5 inline-block print:hidden">
                          <Badge tone="danger">
                            <TriangleAlert aria-hidden className="size-3" />
                            Refus de partage : à réoptimiser
                          </Badge>
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {group.otherCoPassengers > 0 ? (
                  <p className="mt-1 text-xs text-slate-500">
                    + {plural(group.otherCoPassengers, "patient", "patients")} à bord vers ou depuis un autre lieu
                  </p>
                ) : null}
              </Td>
            </tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
