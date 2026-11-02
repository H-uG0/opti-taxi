import type { Metadata } from "next";
import Link from "next/link";
import { Info, Plus, TriangleAlert, UserX } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form";
import { Card, CardBody, EmptyState, PageHeader, Stat } from "@/components/ui/layout";
import { Table, TBody, THead, Th } from "@/components/ui/table";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { OUTBOUND_NO_SHOW_ADVICE, returnsToCheckAfterNoShow } from "@/lib/domain/no-show";
import { formatPercent, PRESCRIBED_MODE_LABELS, SHARING_SCOPE_LABELS } from "@/lib/labels";
import { addDays, formatLongDate, formatShortDate, fromIsoDate, isIsoDate, startOfIsoWeek, tomorrowIso } from "@/lib/time";
import { DayNav } from "./day-nav";
import { GenerateTripsForm } from "./generate-trips-form";
import { TripFiltersForm } from "./trip-filters";
import {
  coPassengersFromStops,
  coursesHref,
  EMPTY_FILTERS,
  filtersToParams,
  filterTrips,
  formatInstant,
  hasActiveFilters,
  parseTripFilters,
  patientDisplayName,
  plural,
  shortPatientName,
  sortTrips,
  summarizeTrips,
} from "./trip-list";
import { TripRow, type TripRowData } from "./trip-row";
import { keyMinute } from "./trip-rules";

export const metadata: Metadata = { title: "Courses" };

type SearchParams = Record<string, string | string[] | undefined>;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export default async function CoursesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser("REGULATOR");
  const params = await searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const date = isIsoDate(rawDate) ? rawDate : tomorrowIso();
  const filters = parseTripFilters(params);
  const serviceDate = fromIsoDate(date);

  const [trips, stops] = await Promise.all([
    db.trip.findMany({
      where: { serviceDate },
      select: {
        id: true,
        patientId: true,
        facilityId: true,
        direction: true,
        status: true,
        payer: true,
        appointmentMinute: true,
        readyMinute: true,
        pickupAddress: true,
        dropoffAddress: true,
        allowedVehicleTypes: true,
        routeId: true,
        plannedPickupMinute: true,
        plannedDropoffMinute: true,
        shared: true,
        directKm: true,
        detourKm: true,
        estimatedRevenue: true,
        sharingAllowed: true,
        sharingStatus: true,
        sharingProposedAt: true,
        sharingRespondedAt: true,
        sharingNote: true,
        notes: true,
        recurrenceId: true,
        patient: { select: { firstName: true, lastName: true, phone: true } },
        facility: { select: { name: true } },
        prescription: { select: { mode: true, sharing: true } },
        recurrence: { select: { label: true } },
        route: { select: { vehicle: { select: { label: true, type: true } } } },
        lockedVehicle: { select: { label: true } },
      },
    }),
    // A cancelled or absent patient is not on board: not a co-passenger.
    db.routeStop.findMany({
      where: { route: { serviceDate }, trip: { status: { notIn: ["CANCELLED", "NO_SHOW"] } } },
      select: { routeId: true, tripId: true, kind: true, sequence: true },
    }),
  ]);

  // Same-day return trips to check: their outbound leg was closed as patient absent.
  const returnsToCheck = returnsToCheckAfterNoShow(trips);
  const dayTrips = trips.map((trip) => ({ ...trip, outboundNoShow: returnsToCheck.has(trip.id) }));
  const summary = summarizeTrips(dayTrips);
  const coPassengers = coPassengersFromStops(stops);
  const shortNames = new Map(trips.map((trip) => [trip.id, shortPatientName(trip.patient)]));
  const visible = sortTrips(filterTrips(dayTrips, filters));

  const rows: TripRowData[] = visible.map((trip) => ({
    id: trip.id,
    direction: trip.direction,
    status: trip.status,
    payer: trip.payer,
    patientName: patientDisplayName(trip.patient),
    patientPhone: trip.patient.phone,
    keyMinute: keyMinute(trip),
    facilityName: trip.facility?.name ?? null,
    pickupAddress: trip.pickupAddress,
    dropoffAddress: trip.dropoffAddress,
    allowedVehicleTypes: trip.allowedVehicleTypes,
    prescriptionLabel:
      trip.payer === "PRIVATE"
        ? "Client privé : sans prescription"
        : trip.prescription
          ? `${PRESCRIBED_MODE_LABELS[trip.prescription.mode]} · partage : ${SHARING_SCOPE_LABELS[trip.prescription.sharing].toLowerCase()}`
          : "Aucune prescription liée",
    origin: trip.recurrenceId ? (trip.recurrence?.label ?? "sans libellé") : null,
    vehicleLabel: trip.route?.vehicle.label ?? null,
    vehicleType: trip.route?.vehicle.type ?? null,
    lockedVehicleLabel: trip.lockedVehicle?.label ?? null,
    plannedPickupMinute: trip.plannedPickupMinute,
    plannedDropoffMinute: trip.plannedDropoffMinute,
    shared: trip.shared,
    coPassengers: (coPassengers.get(trip.id) ?? []).map((id) => shortNames.get(id) ?? "un autre patient"),
    directKm: trip.directKm,
    detourKm: trip.detourKm,
    estimatedRevenue: trip.estimatedRevenue,
    sharingAllowed: trip.sharingAllowed,
    sharingStatus: trip.sharingStatus,
    sharingProposedAt: formatInstant(trip.sharingProposedAt),
    sharingRespondedAt: formatInstant(trip.sharingRespondedAt),
    sharingNote: trip.sharingNote,
    notes: trip.notes,
    outboundNoShow: trip.outboundNoShow,
  }));

  const weekStart = startOfIsoWeek(date);
  const filtered = hasActiveFilters(filters);

  return (
    <div>
      <PageHeader
        title="Courses"
        description={capitalize(formatLongDate(date))}
        actions={
          <LinkButton href={`/courses/nouvelle?date=${date}`} variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouvelle course
          </LinkButton>
        }
      />

      {params.notice === "created" ? (
        <div className="mb-4">
          <FormMessage tone="success">Course créée. Elle sera placée à la prochaine optimisation du planning.</FormMessage>
        </div>
      ) : null}

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <DayNav basePath="/courses" date={date} params={filtersToParams(filters)} />
        {/* Keyed so the feedback of another week does not stay on screen after a client navigation. */}
        <GenerateTripsForm
          key={weekStart}
          weekStart={weekStart}
          nextWeekStart={addDays(weekStart, 7)}
          weekLabel={`${formatShortDate(weekStart)} au ${formatShortDate(addDays(weekStart, 6))}`}
        />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Courses" value={summary.total} hint={`${summary.outbound} aller · ${summary.return} retour`} />
        <Stat
          label="Affectées"
          value={summary.assigned}
          tone={summary.total === 0 ? "default" : summary.unassigned > 0 ? "warn" : "good"}
          hint={summary.unassigned > 0 ? `${summary.unassigned} à placer dans une tournée` : summary.total > 0 ? "Toutes placées" : "—"}
        />
        <Stat
          label="Partagées"
          value={summary.shared}
          hint={summary.assigned > 0 ? `${formatPercent(summary.shared / summary.assigned)} des courses affectées` : "—"}
        />
        <Stat
          label="Refus de partage"
          value={summary.sharingRefused}
          tone={summary.sharingConflicts > 0 ? "bad" : summary.sharingRefused > 0 ? "warn" : "default"}
          hint={
            summary.sharingConflicts > 0
              ? `dont ${summary.sharingConflicts} encore ${summary.sharingConflicts > 1 ? "partagées" : "partagée"} : à réoptimiser`
              : `${plural(summary.sharingAccepted, "accepté", "acceptés")} · ${plural(summary.sharingPending, "sans réponse", "sans réponse")}`
          }
        />
        <Stat label="Annulées" value={summary.cancelled} />
      </div>

      {summary.returnsToCheck > 0 ? (
        <div
          role="note"
          className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          <UserX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">
              {summary.returnsToCheck > 1
                ? `${summary.returnsToCheck} retours à vérifier : l'aller a été déclaré « patient absent ».`
                : "Un retour à vérifier : l'aller a été déclaré « patient absent »."}
            </span>{" "}
            {OUTBOUND_NO_SHOW_ADVICE}{" "}
            <Link
              href={coursesHref(date, { ...EMPTY_FILTERS, status: "RETURN_TO_CHECK" })}
              className="font-medium underline underline-offset-2"
            >
              {summary.returnsToCheck > 1 ? "Voir ces retours" : "Voir ce retour"}
            </Link>
          </span>
        </div>
      ) : null}

      {summary.sharingConflicts > 0 ? (
        <div
          role="note"
          className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {summary.sharingConflicts > 1
              ? `${summary.sharingConflicts} courses sont encore partagées dans le planning malgré le refus du patient.`
              : "Une course est encore partagée dans le planning malgré le refus du patient."}{" "}
            Réoptimisez le planning pour que ces patients voyagent seuls, avant de prévenir les accueils.{" "}
            <Link
              href={coursesHref(date, { ...EMPTY_FILTERS, sharing: "REFUSED" })}
              className="font-medium underline underline-offset-2"
            >
              Voir les refus
            </Link>
            {" · "}
            <Link href={`/planning?date=${date}`} className="font-medium underline underline-offset-2">
              Ouvrir le planning
            </Link>
          </span>
        </div>
      ) : null}

      <Card className="mb-4">
        <CardBody className="py-3">
          {/* Keyed by the URL: uncontrolled fields must show the filters in use after a client navigation (e.g. « Réinitialiser »). */}
          <TripFiltersForm key={coursesHref(date, filters)} date={date} filters={filters} />
        </CardBody>
      </Card>

      <p className="mb-3 flex items-start gap-2 text-xs text-slate-600">
        <Info aria-hidden className="mt-px size-4 shrink-0 text-sky-700" />
        <span>
          Transport partagé : la proposition (horodatée par l&apos;optimisation) et la réponse du patient sont tracées sur
          chaque course (bouton « Détails »). Un refus est mentionné sur la facture ; le patient avance alors les frais
          (décret 2025-202, art. R. 322-11-4). Un patient qui refuse n&apos;est plus regroupé à la prochaine optimisation.
        </span>
      </p>

      {trips.length === 0 ? (
        <EmptyState
          title={`Aucune course le ${formatLongDate(date)}`}
          action={
            <LinkButton href={`/courses/nouvelle?date=${date}`} variant="secondary">
              <Plus aria-hidden className="size-4" />
              Nouvelle course
            </LinkButton>
          }
        >
          Générez les courses de la semaine à partir des récurrences, ou créez une course ponctuelle.
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucune course ne correspond aux filtres"
          action={<LinkButton href={coursesHref(date)}>Réinitialiser les filtres</LinkButton>}
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-600" aria-live="polite">
            {filtered
              ? `${plural(rows.length, "course affichée", "courses affichées")} sur ${trips.length}`
              : plural(rows.length, "course", "courses")}
            , triées par heure de rendez-vous (aller) ou de fin de séance (retour).
          </p>
          <Table>
            <caption className="sr-only">Courses du {formatLongDate(date)}</caption>
            <THead>
              <tr>
                <Th>Heure</Th>
                <Th>Patient</Th>
                <Th>Trajet</Th>
                <Th className="hidden lg:table-cell">Types · payeur</Th>
                <Th>Statut</Th>
                <Th>Véhicule</Th>
                <Th>Partage</Th>
                <Th>
                  <span className="sr-only">Détails</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TripRow key={row.id} trip={row} />
              ))}
            </TBody>
          </Table>
        </>
      )}
    </div>
  );
}
