import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCoordinate } from "@/components/address/address-utils";
import { BackLink } from "@/components/ui/back-link";
import { LinkButton } from "@/components/ui/button";
import { Card, CardBody, PageHeader } from "@/components/ui/layout";
import { Notice } from "@/components/ui/notice";
import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { isExceptionalAmbulanceTrip } from "@/lib/planning/exceptional-ambulance";
import { db } from "@/lib/db";
import { formatAddress } from "@/lib/domain/rules";
import { geocoderEnabled } from "@/lib/geocode";
import { DIRECTION_LABELS, FACILITY_TYPE_LABELS } from "@/lib/labels";
import { formatPersonName } from "@/lib/names";
import { formatLongDate, formatMinute, formatShortDate, isoWeekday, todayIso, toIsoDate, WEEKDAY_LABELS } from "@/lib/time";
import { describeRhythmDays, sessionTimesOn } from "@/lib/domain/recurrence-rhythm";
import { canEditTime, keyMinute } from "../../trip-rules";
import { EditTripForm, type EditTripInitial } from "./edit-trip-form";

export const metadata: Metadata = { title: "Modifier la course" };

/**
 * « Modifier la course ». ?retour=patient: opened from the patient's record,
 * where the back link and « Annuler » lead (the save still goes to Courses,
 * where « Où la placer ? » is offered).
 */
export default async function EditTripPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("REGULATOR");
  const { id } = await params;
  const fromRecord = (await searchParams).retour === "patient";
  const trip = await db.trip.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      serviceDate: true,
      occurrenceDate: true,
      direction: true,
      payer: true,
      facilityId: true,
      appointmentMinute: true,
      readyMinute: true,
      pickupAddress: true,
      pickupLat: true,
      pickupLng: true,
      dropoffAddress: true,
      dropoffLat: true,
      dropoffLng: true,
      oneOffAddress: true,
      notes: true,
      routeId: true,
      allowedVehicleTypes: true,
      lockedVehicleId: true,
      exceptionalAmbulanceAt: true,
      route: { select: { status: true, vehicle: { select: { label: true } } } },
      lockedVehicle: { select: { label: true, type: true } },
      patient: { select: { id: true, firstName: true, lastName: true, address: true, postalCode: true, city: true } },
      recurrence: {
        select: {
          id: true,
          label: true,
          weekdays: true,
          intervalWeeks: true,
          sessionDates: true,
          appointmentMinute: true,
          sessionMinutes: true,
          daySchedules: true,
          facility: { select: { name: true } },
        },
      },
    },
  });
  if (!trip) notFound();
  const date = toIsoDate(trip.serviceDate);
  // The patient's addresses and the trip's notes are on screen.
  await auditRead(user, { action: "trip.view", entity: "Trip", entityId: trip.id, serviceDate: date });

  const today = todayIso();
  const editable = canEditTime(trip.status) && date >= today;
  const facilities = editable
    ? await db.facility.findMany({
        where: { OR: [{ active: true }, ...(trip.facilityId ? [{ id: trip.facilityId }] : [])] },
        orderBy: { name: "asc" },
        select: { id: true, name: true, city: true, type: true, active: true },
      })
    : [];

  const outbound = trip.direction === "OUTBOUND";
  const home = outbound
    ? { address: trip.pickupAddress, lat: trip.pickupLat, lng: trip.pickupLng }
    : { address: trip.dropoffAddress, lat: trip.dropoffLat, lng: trip.dropoffLng };
  const care = outbound
    ? { address: trip.dropoffAddress, lat: trip.dropoffLat, lng: trip.dropoffLng }
    : { address: trip.pickupAddress, lat: trip.pickupLat, lng: trip.pickupLng };
  const minute = keyMinute(trip);
  const initial: EditTripInitial = {
    serviceDate: date,
    time: minute !== null ? formatMinute(minute) : "",
    facilityId: trip.facilityId ?? "",
    homeMode: trip.oneOffAddress ? "other" : "home",
    homeAddress: trip.oneOffAddress ? home.address : "",
    homeLat: trip.oneOffAddress ? formatCoordinate(home.lat) : "",
    homeLng: trip.oneOffAddress ? formatCoordinate(home.lng) : "",
    careAddress: trip.facilityId === null ? care.address : "",
    careLat: trip.facilityId === null ? formatCoordinate(care.lat) : "",
    careLng: trip.facilityId === null ? formatCoordinate(care.lng) : "",
    notes: trip.notes ?? "",
  };
  const back = fromRecord ? `/patients/${trip.patient.id}` : `/courses?date=${date}`;
  const occurrence = trip.occurrenceDate ? toIsoDate(trip.occurrenceDate) : null;
  const recurrence = trip.recurrence;
  // The session the trip serves may be at its weekday's own time (« Ven 07:30 » on a « Lun Mer Ven 13:00 »).
  const sessionDay = occurrence ?? date;
  const sessionMinute = recurrence ? sessionTimesOn(recurrence, sessionDay).appointmentMinute : null;
  const exceptional = isExceptionalAmbulanceTrip(trip, () => trip.lockedVehicle?.type);

  return (
    <div className="max-w-3xl">
      <BackLink href={back}>{fromRecord ? "Fiche patient" : `Courses du ${formatShortDate(date)}`}</BackLink>
      <PageHeader
        title="Modifier la course"
        description={`${formatPersonName(trip.patient)} · ${DIRECTION_LABELS[trip.direction]} · ${formatLongDate(date)}`}
      />
      <div className="mb-5 space-y-2">
        {recurrence ? (
          <Notice size="sm" tone="info">
            Course de la récurrence {describeRhythmDays({ ...recurrence, sessionDates: recurrence.sessionDates.map(toIsoDate) })}{" "}
            {formatMinute(recurrence.appointmentMinute)}
            {sessionMinute !== null && sessionMinute !== recurrence.appointmentMinute
              ? `, le ${WEEKDAY_LABELS[isoWeekday(sessionDay)]?.toLowerCase()} à ${formatMinute(sessionMinute)}`
              : ""}
            {recurrence.label ? ` (${recurrence.label})` : ` (${recurrence.facility.name})`}&nbsp;: les changements ne valent que pour
            cette course, qui reste rattachée à sa récurrence.
            {occurrence && occurrence !== date ? ` Elle remplace la séance du ${formatShortDate(occurrence)}.` : ""}{" "}
            <Link href={`/patients/${trip.patient.id}/recurrences/${recurrence.id}/modifier`} className="font-medium underline underline-offset-2">
              Modifier la récurrence
            </Link>
          </Notice>
        ) : null}
        {editable && trip.route ? (
          <Notice size="sm" tone="warning">
            Dans la tournée de {trip.route.vehicle.label}&nbsp;: une autre date, une autre adresse ou un autre établissement l&apos;en
            retirent (la tournée est alors recalculée) et elle sera à replacer. Un horaire seul la laisse dans sa tournée s&apos;il reste
            compatible.
            {trip.route.status === "VALIDATED" ? " Planning validé : prévenez le chauffeur." : ""}
          </Notice>
        ) : null}
        {editable && trip.lockedVehicle ? (
          <Notice size="sm" tone="warning">
            {exceptional
              ? `Recours exceptionnel à l'ambulance ${trip.lockedVehicle.label}\u00a0: une autre date le retire (la course revient au taxi ou au VSL).`
              : `Figée sur ${trip.lockedVehicle.label}\u00a0: une autre date la défige (l'optimisation lui choisira un véhicule ce jour-là).`}
          </Notice>
        ) : null}
      </div>
      {editable ? (
        <Card>
          <CardBody>
            <EditTripForm
              tripId={trip.id}
              direction={trip.direction}
              payer={trip.payer}
              homeAddress={formatAddress(trip.patient)}
              facilities={facilities.map((f) => ({
                id: f.id,
                label: `${f.name} — ${f.city} (${FACILITY_TYPE_LABELS[f.type]})${f.active ? "" : " — désactivé"}`,
              }))}
              initial={initial}
              today={today}
              geocoder={geocoderEnabled()}
              cancelHref={back}
              recurrenceLabel={recurrence ? (recurrence.label ?? recurrence.facility.name) : null}
            />
          </CardBody>
        </Card>
      ) : (
        <Notice
          tone="warning"
          title={date < today ? "Course d'un jour passé" : "Cette course ne peut plus être modifiée"}
        >
          <p>
            {date < today
              ? "Les courses des jours passés restent telles qu'elles ont été faites."
              : "Elle est commencée, terminée, annulée ou le patient était absent."}
          </p>
          <p className="mt-2">
            <LinkButton href={back} size="sm" variant="secondary">
              {fromRecord ? "Retour à la fiche patient" : "Retour aux courses"}
            </LinkButton>
          </p>
        </Notice>
      )}
    </div>
  );
}
