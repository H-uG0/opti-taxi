import type { Metadata } from "next";
import Link from "next/link";
import { Info, Plus, TriangleAlert, UserX } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form";
import { Card, CardBody, EmptyState, PageHeader, Stat } from "@/components/ui/layout";
import { auditRead } from "@/lib/audit";
import { cancellationLabel } from "@/lib/domain/cancellation";
import { conflictLabel, tripConflicts } from "@/lib/domain/duplicates";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { OUTBOUND_NO_SHOW_ADVICE, returnsToCheckAfterNoShow } from "@/lib/domain/no-show";
import { compareLabels, compareVehiclesByDepot } from "@/lib/fleet/order";
import { formatPercent, PRESCRIBED_MODE_LABELS, SHARING_SCOPE_LABELS } from "@/lib/labels";
import { addDays, formatLongDate, formatShortDate, fromIsoDate, isIsoDate, startOfIsoWeek, todayIso, tomorrowIso } from "@/lib/time";
import { currentHorizon, inHorizon } from "@/lib/trips/completion";
import { loadRecurrencesWithoutTrip } from "@/lib/trips/missing-load";
import { generationStateOf, MissingRecurrencesNote } from "@/components/trips/missing-recurrences";
import { TripCompletion } from "@/components/trips/trip-completion";
import { SimulatedDayBadge } from "@/components/planning/simulated-day-badge";
import { isSimulatedDay } from "@/lib/simulated-day";
import { DayNav } from "./day-nav";
import { GenerateTripsForm } from "./generate-trips-form";
import { cancellationTrace, exceptionalAmbulanceTrace, outboundNoShowTrace, sharingAnswerTrace, stopStatusTraces } from "./record-trace";
import { TripFiltersForm, type TripFilterChoices } from "./trip-filters";
import {
  coPassengersFromStops,
  coursesHref,
  EMPTY_FILTERS,
  filtersToParams,
  filterTrips,
  formatInstant,
  pairedReturns,
  hasActiveFilters,
  NO_FACILITY,
  parseTripFilters,
  patientDisplayName,
  plural,
  shortPatientName,
  sortTrips,
  summarizeTrips,
  UNASSIGNED,
} from "./trip-list";
import { planningTripHref } from "@/lib/planning/links";
import type { TripRowData } from "./trip-row";
import { TripTable } from "./trip-table";
import { keyMinute } from "./trip-rules";

export const metadata: Metadata = { title: "Courses" };

type SearchParams = Record<string, string | string[] | undefined>;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export default async function CoursesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser("REGULATOR");
  const params = await searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const date = isIsoDate(rawDate) ? rawDate : tomorrowIso();
  const filters = parseTripFilters(params);
  const serviceDate = fromIsoDate(date);

  // The day's patients, phones, addresses and notes are on screen (auditRead never throws).
  const traced = auditRead(user, { action: "trip_list.view", entity: "Trip", entityId: null, serviceDate: date });
  const today = todayIso();
  const [trips, stops, horizon, missing, simulated, depots] = await Promise.all([
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
        tollAmount: true,
        sharingAllowed: true,
        sharingStatus: true,
        sharingProposedAt: true,
        sharingRespondedAt: true,
        sharingNote: true,
        notes: true,
        recurrenceId: true,
        cancellationReason: true,
        cancellationOrigin: true,
        cancellationNote: true,
        cancelledAt: true,
        lateCancellation: true,
        cancelledBy: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true, phone: true } },
        facility: { select: { name: true } },
        prescription: { select: { mode: true, sharing: true } },
        recurrence: { select: { label: true } },
        route: { select: { vehicle: { select: { id: true, label: true, type: true, depotId: true, depot: { select: { name: true } } } } } },
        lockedVehicleId: true,
        lockedVehicle: { select: { label: true, type: true } },
        // « Recours exceptionnel à une ambulance »: who proposed it and when (account name only).
        exceptionalAmbulanceAt: true,
        exceptionalAmbulanceBy: { select: { name: true } },
        // Who recorded the answer and the crew's statuses: account names only.
        sharingRespondedBy: { select: { name: true } },
        stops: {
          where: { completedAt: { not: null } },
          select: { kind: true, completedAt: true, completedBy: { select: { name: true } } },
        },
      },
    }),
    // A cancelled or absent patient is not on board: not a co-passenger.
    db.routeStop.findMany({
      where: { route: { serviceDate }, trip: { status: { notIn: ["CANCELLED", "NO_SHOW"] } } },
      select: { routeId: true, tripId: true, kind: true, sequence: true },
    }),
    // Read only: the trips of a date of the horizon are completed by <TripCompletion> once the page is shown.
    currentHorizon(db, today),
    date >= today ? loadRecurrencesWithoutTrip(date) : Promise.resolve([]),
    // Its statuses and sharing answers are simulated: said in the header, as on the planning.
    isSimulatedDay(date),
    db.depot.findMany({ select: { id: true, name: true } }),
  ]);
  await traced;
  const completing = inHorizon(date, horizon);

  // Same-day return trips to check: their outbound leg was closed as patient absent.
  const returnsToCheck = returnsToCheckAfterNoShow(trips);
  const dayTrips = trips.map((trip) => ({ ...trip, outboundNoShow: returnsToCheck.has(trip.id) }));
  const summary = summarizeTrips(dayTrips);
  const coPassengers = coPassengersFromStops(stops);
  const shortNames = new Map(trips.map((trip) => [trip.id, shortPatientName(trip.patient)]));
  const visible = sortTrips(filterTrips(dayTrips, filters));
  // A link from the planning filters on a patient by id: the form names that patient.
  const filteredPatient = filters.patient ? trips.find((trip) => trip.patientId === filters.patient)?.patient : undefined;
  const patientLabel = filteredPatient ? patientDisplayName(filteredPatient) : null;
  const returns = pairedReturns(trips);
  // The lists of the filter bar: the facilities and vehicles of the day (by depot, in the usual order), every depot.
  const facilityNames = new Map<string, string>();
  const dayVehicles = new Map<string, TripFilterChoices["vehicles"][number]>();
  for (const trip of trips) {
    if (trip.facilityId && trip.facility) facilityNames.set(trip.facilityId, trip.facility.name);
    const vehicle = trip.route?.vehicle;
    if (vehicle) dayVehicles.set(vehicle.id, { id: vehicle.id, label: vehicle.label, type: vehicle.type, depotName: vehicle.depot.name });
  }
  // The vehicle or facility filtered on stays in its list on a day it has nothing (kept by the date arrows):
  // the bar shows the filter in force instead of a blank list.
  const [filteredVehicle, filteredFacility] = await Promise.all([
    filters.vehicle && filters.vehicle !== UNASSIGNED && !dayVehicles.has(filters.vehicle)
      ? db.vehicle.findUnique({ where: { id: filters.vehicle }, select: { id: true, label: true, type: true, depot: { select: { name: true } } } })
      : null,
    filters.facility && filters.facility !== NO_FACILITY && !facilityNames.has(filters.facility)
      ? db.facility.findUnique({ where: { id: filters.facility }, select: { id: true, name: true } })
      : null,
  ]);
  if (filteredVehicle) {
    dayVehicles.set(filteredVehicle.id, { ...filteredVehicle, depotName: filteredVehicle.depot.name });
  }
  if (filteredFacility) facilityNames.set(filteredFacility.id, filteredFacility.name);
  const choices: TripFilterChoices = {
    facilities: [...facilityNames].map(([id, name]) => ({ id, name })).sort((a, b) => compareLabels(a.name, b.name)),
    vehicles: [...dayVehicles.values()].sort(compareVehiclesByDepot),
    depots: [...depots].sort((a, b) => compareLabels(a.name, b.name)),
  };
  // Same patient, same day: a trip on the same leg, or during another care session (two vehicles for one patient?).
  const conflicts = new Map(
    trips.map((trip) => [trip.id, tripConflicts(trip, trips).map((c) => conflictLabel(c, trip.direction))] as const),
  );
  const createdId = Array.isArray(params.course) ? params.course[0] : params.course;
  const createdConflicts = createdId ? (conflicts.get(createdId) ?? []) : [];

  const rows: TripRowData[] = visible.map((trip) => {
    const answer = sharingAnswerTrace(trip);
    const statusTraces = stopStatusTraces(trip.status, trip.stops);
    const cancelled = trip.status === "CANCELLED";
    return {
      id: trip.id,
      direction: trip.direction,
      status: trip.status,
      statusTraces: statusTraces.map((trace) => trace.full),
      statusTraceShort: statusTraces.at(-1)?.short ?? null,
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
      exceptionalAmbulance: exceptionalAmbulanceTrace(trip),
      plannedPickupMinute: trip.plannedPickupMinute,
      plannedDropoffMinute: trip.plannedDropoffMinute,
      shared: trip.shared,
      coPassengers: (coPassengers.get(trip.id) ?? []).map((id) => shortNames.get(id) ?? "un autre patient"),
      directKm: trip.directKm,
      detourKm: trip.detourKm,
      estimatedRevenue: trip.estimatedRevenue,
      tollAmount: trip.tollAmount,
      sharingAllowed: trip.sharingAllowed,
      sharingStatus: trip.sharingStatus,
      sharingProposedAt: formatInstant(trip.sharingProposedAt),
      // Only for a current answer (accepted, refused): the badge shows it.
      sharingAnswer: answer?.full ?? null,
      sharingAnswerShort: answer?.short ?? null,
      sharingNote: trip.sharingNote,
      notes: trip.notes,
      outboundNoShow: trip.outboundNoShow,
      // Read from the whole day: the outbound trip may be filtered out of the list.
      outboundNoShowTrace: trip.outboundNoShow ? outboundNoShowTrace(trip, trips) : null,
      cancellation: cancelled ? cancellationLabel(trip) : null,
      cancellationReason: cancelled ? cancellationLabel({ ...trip, lateCancellation: false }) : null,
      lateCancellation: cancelled && trip.lateCancellation,
      cancellationTrace: cancellationTrace(trip),
      pairedReturn: returns.get(trip.id) ?? null,
      conflicts: conflicts.get(trip.id) ?? [],
      // The planning shows the trips still to plan and those still in a route (a cancelled one there included).
      planningHref:
        (trip.status !== "CANCELLED" && trip.status !== "NO_SHOW") || trip.routeId !== null ? planningTripHref(date, trip.id) : null,
    };
  });

  const weekStart = startOfIsoWeek(date);
  const filtered = hasActiveFilters(filters);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>Courses</span>
            {simulated ? <SimulatedDayBadge /> : null}
          </span>
        }
        description={capitalize(formatLongDate(date))}
        actions={
          <LinkButton href={`/courses/nouvelle?date=${date}`} variant="primary">
            <Plus aria-hidden className="size-4" />
            Nouvelle course
          </LinkButton>
        }
      />

      {params.notice === "created" ? (
        <div className="mb-4 space-y-2">
          <FormMessage tone="success">Course créée. Elle sera placée à la prochaine optimisation du planning.</FormMessage>
          {createdConflicts.length > 0 ? (
            <p role="note" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700" />
              <span>
                Attention : {createdConflicts.join(" ; ")}. Vérifiez qu&apos;il ne s&apos;agit pas d&apos;un doublon (deux
                véhicules pour un même patient) ; sinon, annulez l&apos;une des deux courses.
              </span>
            </p>
          ) : null}
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
          horizonEnd={horizon.to}
        />
      </div>
      {completing ? (
        <TripCompletion key={date} date={date} missing={missing} onCourses className="mb-4" />
      ) : (
        <MissingRecurrencesNote missing={missing} state={generationStateOf(date, today, false)} onCourses className="mb-4" />
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Courses" value={summary.total} hint={`${summary.outbound} aller · ${summary.return} retour`} />
        <Stat
          label="Affectées"
          value={summary.assigned}
          tone={summary.total === 0 ? "default" : summary.unassigned > 0 ? "warn" : "good"}
          hint={
            summary.unassigned > 0 ? (
              <Link href={coursesHref(date, { ...EMPTY_FILTERS, vehicle: UNASSIGNED })} className="underline underline-offset-2">
                {summary.unassigned} à placer dans une tournée
              </Link>
            ) : summary.total > 0 ? (
              "Toutes placées"
            ) : (
              "—"
            )
          }
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
          <TripFiltersForm date={date} filters={filters} choices={choices} patientLabel={patientLabel} />
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
          Les courses régulières sont créées d&apos;office jusqu&apos;au {formatShortDate(horizon.to)} à partir des
          récurrences ; au-delà, générez-les pour la semaine, ou créez une course ponctuelle.
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
          {/* Keyed by date: the selection and the last answer do not follow the date arrows (client navigation). */}
          <TripTable key={date} rows={rows} caption={`Courses du ${formatLongDate(date)}`} />
        </>
      )}
    </div>
  );
}
