"use server";

import type { Prisma, RouteStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatAddress } from "@/lib/domain/rules";
import { getSettings } from "@/lib/domain/settings";
import { generateTrips } from "@/lib/domain/trip-generation";
import { geocodeAddress, geocoderEnabled } from "@/lib/geocode";
import { formatMinute, addDays, todayIso } from "@/lib/time";
import {
  buildNewTripData,
  firstErrorMessage,
  formValues,
  generateWeekSchema,
  NEW_TRIP_FIELDS,
  parseNewTrip,
  prescriptionUsableOn,
  scheduleSchema,
  sharingDecisionSchema,
  tripIdSchema,
  type ActionResult,
  type FieldErrors,
  type NewTripValues,
  type TripDestination,
  type TripPrescription,
} from "./trip-form";
import { planDetach } from "./route-detach";
import { checkScheduleFit, type ScheduleFit } from "./schedule-fit";
import { sharingDecisionData } from "./sharing-decision";
import { generationMessage } from "./trip-list";
import { canCancel, canEditTime, canRestore, keyMinuteLabel, sharingDecisionsFor, SHARING_DECISION_LABELS } from "./trip-rules";

/** Pages that show trips or route stops: refreshed after every change. */
function revalidateTripViews() {
  revalidatePath("/courses");
  revalidatePath("/arrivees-partagees");
  revalidatePath("/planning");
  revalidatePath("/chauffeur");
}

function failure(message: string): ActionResult {
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Week generation

export async function generateWeekTrips(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const parsed = generateWeekSchema.safeParse(formValues(formData, ["weekStart"]));
  if (!parsed.success) return failure(firstErrorMessage(parsed.error));

  const from = parsed.data.weekStart;
  const to = addDays(from, 6);
  try {
    const result = await generateTrips(db, from, to);
    revalidateTripViews();
    return { ok: true, message: generationMessage(result, from, to) };
  } catch (error) {
    console.error("generateWeekTrips failed", error);
    return failure("La génération des courses a échoué. Réessayez ou contactez l'administrateur.");
  }
}

// ---------------------------------------------------------------------------
// One-off trip

export type NewTripState = {
  errors: FieldErrors;
  message: string | null;
  values: NewTripValues;
  /** Incremented on every answer so the form remounts with the submitted values. */
  attempt: number;
};

/** Destination of a private trip without facility: typed coordinates, or geocoded address. */
async function freeDestination(
  address: string,
  lat: number | undefined,
  lng: number | undefined,
): Promise<{ ok: true; destination: TripDestination } | { ok: false; field: string; message: string }> {
  if (lat !== undefined && lng !== undefined) {
    return { ok: true, destination: { facilityId: null, address, lat, lng } };
  }
  if (!geocoderEnabled()) {
    return { ok: false, field: "destinationLat", message: "Géocodage indisponible : saisissez la latitude et la longitude." };
  }
  try {
    const [best] = await geocodeAddress(address, 1);
    if (!best || best.score < 0.5) {
      return { ok: false, field: "destinationAddress", message: "Adresse introuvable ou imprécise : précisez-la ou saisissez les coordonnées." };
    }
    return { ok: true, destination: { facilityId: null, address: best.label, lat: best.lat, lng: best.lng } };
  } catch (error) {
    console.error("geocodeAddress failed", error);
    return { ok: false, field: "destinationAddress", message: "Le géocodage n'a pas répondu : saisissez la latitude et la longitude." };
  }
}

export async function createTrip(prev: NewTripState, formData: FormData): Promise<NewTripState> {
  await requireUser("REGULATOR");
  const values = formValues(formData, NEW_TRIP_FIELDS);
  const answer = (errors: FieldErrors, message: string | null = null): NewTripState => ({
    errors,
    message: message ?? "Vérifiez les champs signalés.",
    values,
    attempt: prev.attempt + 1,
  });

  const parsed = parseNewTrip(values, todayIso());
  if (!parsed.ok) return answer(parsed.errors);
  const input = parsed.data;

  const patient = await db.patient.findFirst({
    where: { id: input.patientId, active: true },
    select: { id: true, address: true, postalCode: true, city: true, lat: true, lng: true },
  });
  if (!patient) return answer({ patientId: ["Patient introuvable ou archivé."] });

  let prescription: TripPrescription | null = null;
  if (input.payer === "CPAM") {
    const found = input.prescriptionId
      ? await db.prescription.findUnique({
          where: { id: input.prescriptionId },
          select: { id: true, patientId: true, mode: true, sharing: true, validFrom: true, validTo: true },
        })
      : null;
    if (!found || !prescriptionUsableOn(found, patient.id, input.serviceDate)) {
      return answer({ prescriptionId: ["Cette prescription n'appartient pas au patient ou n'est pas valide à cette date."] });
    }
    prescription = { id: found.id, mode: found.mode, sharing: found.sharing };
  }

  let destination: TripDestination;
  if (input.facilityId) {
    const facility = await db.facility.findFirst({
      where: { id: input.facilityId, active: true },
      select: { id: true, address: true, postalCode: true, city: true, lat: true, lng: true },
    });
    if (!facility) return answer({ facilityId: ["Établissement introuvable ou archivé."] });
    destination = { facilityId: facility.id, address: formatAddress(facility), lat: facility.lat, lng: facility.lng };
  } else {
    const free = await freeDestination(input.destinationAddress ?? "", input.destinationLat, input.destinationLng);
    if (!free.ok) return answer({ [free.field]: [free.message] });
    destination = free.destination;
  }

  const data = buildNewTripData(input, patient, prescription, destination);
  try {
    await db.trip.create({ data });
  } catch (error) {
    console.error("createTrip failed", error);
    return answer({}, "La course n'a pas pu être enregistrée. Réessayez.");
  }

  revalidateTripViews();
  redirect(`/courses?date=${input.serviceDate}&notice=created`);
}

// ---------------------------------------------------------------------------
// Row actions

/** Planning results that no longer hold once the trip leaves its route (the regulator's lock is kept). */
const DETACHED_PLANNING = {
  routeId: null,
  plannedPickupMinute: null,
  plannedDropoffMinute: null,
  shared: false,
  detourKm: null,
  estimatedRevenue: null,
} satisfies Prisma.TripUncheckedUpdateManyInput;

/** Cancelling (or restoring) also drops the lock: the trip starts afresh. */
const CLEARED_PLANNING = { ...DETACHED_PLANNING, lockedVehicleId: null } satisfies Prisma.TripUncheckedUpdateManyInput;

const CONCURRENT_CHANGE = "La course a changé entre-temps : rechargez la page.";

/**
 * Takes the trip's stops out of the route(s) serving it, in the caller's
 * transaction. The remaining stops keep their order and times but get their
 * load recomputed; former co-passengers lose their shared-discounted revenue
 * and detour, and those left alone are no longer shared, so neither /courses
 * nor the reception list announce a shared transport that no longer exists.
 * Returns how many co-passengers now travel alone.
 */
async function removeTripStops(tx: Prisma.TransactionClient, tripId: string): Promise<number> {
  const own = await tx.routeStop.findMany({ where: { tripId }, select: { routeId: true } });
  if (own.length === 0) return 0;
  const stops = await tx.routeStop.findMany({
    where: { routeId: { in: [...new Set(own.map((stop) => stop.routeId))] } },
    select: { id: true, routeId: true, tripId: true, kind: true, sequence: true, loadAfter: true },
  });
  const plan = planDetach(stops, tripId);

  await tx.routeStop.deleteMany({ where: { tripId } });
  for (const { id, loadAfter } of plan.loadUpdates) {
    await tx.routeStop.update({ where: { id }, data: { loadAfter } });
  }
  if (plan.nowAlone.length > 0) {
    await tx.trip.updateMany({
      where: { id: { in: plan.nowAlone } },
      data: { shared: false, detourKm: null, estimatedRevenue: null },
    });
  }
  if (plan.stillShared.length > 0) {
    await tx.trip.updateMany({ where: { id: { in: plan.stillShared } }, data: { detourKm: null, estimatedRevenue: null } });
  }
  return plan.nowAlone.length;
}

/** " Son co-passager voyage désormais seul." */
function aloneMessage(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? " Son co-passager voyage désormais seul (transport non partagé)."
    : ` ${count} co-passagers voyagent désormais seuls (transport non partagé).`;
}

/** Reminder when the day's plan is validated: it must be reopened before re-optimizing. */
function validatedHint(routeStatus: RouteStatus | null | undefined): string {
  return routeStatus === "VALIDATED" ? " Le planning est validé : rouvrez-le avant de réoptimiser." : "";
}

export async function cancelTrip(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const parsed = tripIdSchema.safeParse(formData.get("tripId"));
  if (!parsed.success) return failure("Course introuvable.");

  const trip = await db.trip.findUnique({
    where: { id: parsed.data },
    select: { id: true, status: true, routeId: true, route: { select: { status: true } } },
  });
  if (!trip) return failure("Course introuvable.");
  if (!canCancel(trip.status)) return failure("Seule une course pas encore commencée peut être annulée.");

  // Guarded on the status read above so a concurrent change is not overwritten;
  // the stops are removed only when the trip really leaves its route.
  const outcome = await db.$transaction(async (tx) => {
    const updated = await tx.trip.updateMany({
      where: { id: trip.id, status: trip.status },
      data: { ...CLEARED_PLANNING, status: "CANCELLED" },
    });
    if (updated.count === 0) return null;
    return { nowAlone: await removeTripStops(tx, trip.id) };
  });
  if (!outcome) return failure(CONCURRENT_CHANGE);

  revalidateTripViews();
  return {
    ok: true,
    message: trip.routeId
      ? `Course annulée et retirée de sa tournée.${aloneMessage(outcome.nowAlone)} Réoptimisez le planning.${validatedHint(trip.route?.status)}`
      : "Course annulée.",
  };
}

export async function restoreTrip(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const parsed = tripIdSchema.safeParse(formData.get("tripId"));
  if (!parsed.success) return failure("Course introuvable.");

  const trip = await db.trip.findUnique({ where: { id: parsed.data }, select: { id: true, status: true } });
  if (!trip) return failure("Course introuvable.");
  if (!canRestore(trip.status)) return failure("Seule une course annulée peut être rétablie.");

  const restored = await db.$transaction(async (tx) => {
    const updated = await tx.trip.updateMany({
      where: { id: trip.id, status: "CANCELLED" },
      data: { ...CLEARED_PLANNING, status: "PLANNED" },
    });
    if (updated.count === 0) return false;
    // A trip cancelled elsewhere may still have stops: it starts afresh, outside any route.
    await removeTripStops(tx, trip.id);
    return true;
  });
  if (!restored) return failure(CONCURRENT_CHANGE);

  revalidateTripViews();
  return { ok: true, message: "Course rétablie : elle sera placée à la prochaine optimisation." };
}

export async function rescheduleTrip(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const parsed = scheduleSchema.safeParse(formValues(formData, ["tripId", "time"]));
  if (!parsed.success) return failure(firstErrorMessage(parsed.error));

  const trip = await db.trip.findUnique({
    where: { id: parsed.data.tripId },
    select: {
      id: true,
      status: true,
      direction: true,
      routeId: true,
      patientId: true,
      serviceDate: true,
      route: { select: { status: true, vehicle: { select: { label: true } } } },
    },
  });
  if (!trip) return failure("Course introuvable.");
  if (!canEditTime(trip.status)) return failure("L'horaire d'une course commencée ou annulée ne peut plus changer.");

  const minute = parsed.data.time;
  const timeData = trip.direction === "OUTBOUND" ? { appointmentMinute: minute } : { readyMinute: minute };

  // In a route: the planned stop must still respect the new window (and the
  // patient's total wait), otherwise the stored plan would break a hard rule
  // that the optimizer's validator never sees.
  let fit: ScheduleFit = { fits: true };
  if (trip.routeId) {
    const [settings, patientTrips] = await Promise.all([
      getSettings(db),
      db.trip.findMany({
        where: { patientId: trip.patientId, serviceDate: trip.serviceDate, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
        select: {
          id: true,
          direction: true,
          facilityId: true,
          appointmentMinute: true,
          readyMinute: true,
          routeId: true,
          plannedPickupMinute: true,
          plannedDropoffMinute: true,
        },
      }),
    ]);
    const planned = patientTrips.map(({ routeId, ...t }) => ({
      ...t,
      plannedPickupMinute: routeId ? t.plannedPickupMinute : null,
      plannedDropoffMinute: routeId ? t.plannedDropoffMinute : null,
    }));
    fit = checkScheduleFit(trip.id, minute, planned, settings);
  }

  const outcome = await db.$transaction(async (tx) => {
    const updated = await tx.trip.updateMany({
      where: { id: trip.id, status: trip.status, routeId: trip.routeId },
      data: fit.fits ? timeData : { ...timeData, ...DETACHED_PLANNING, status: "PLANNED" },
    });
    if (updated.count === 0) return null;
    return { nowAlone: fit.fits ? 0 : await removeTripStops(tx, trip.id) };
  });
  if (!outcome) return failure(CONCURRENT_CHANGE);

  revalidateTripViews();
  const label = `${keyMinuteLabel(trip.direction)} à ${formatMinute(minute)}.`;
  if (!trip.routeId) return { ok: true, message: `${label} Pris en compte à la prochaine optimisation.` };
  const vehicle = trip.route?.vehicle.label ?? "son véhicule";
  if (fit.fits) {
    return { ok: true, message: `${label} L'horaire prévu dans la tournée de ${vehicle} reste compatible.` };
  }
  return {
    ok: true,
    message:
      `${label} La tournée de ${vehicle} ne tenait plus (${fit.reason}) : la course en a été retirée.` +
      `${aloneMessage(outcome.nowAlone)} Réoptimisez le planning pour la replacer.${validatedHint(trip.route?.status)}`,
  };
}

export async function recordSharingDecision(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser("REGULATOR");
  const parsed = sharingDecisionSchema.safeParse(formValues(formData, ["tripId", "decision", "note"]));
  if (!parsed.success) return failure(firstErrorMessage(parsed.error));
  const { tripId, decision, note } = parsed.data;

  const trip = await db.trip.findUnique({
    where: { id: tripId },
    select: {
      id: true,
      status: true,
      sharingAllowed: true,
      sharingStatus: true,
      sharingProposedAt: true,
      sharingRespondedAt: true,
      sharingNote: true,
      shared: true,
    },
  });
  if (!trip) return failure("Course introuvable.");
  if (!sharingDecisionsFor(trip).includes(decision)) {
    return failure(
      !trip.sharingAllowed || trip.sharingStatus === "NOT_ELIGIBLE"
        ? "La prescription n'autorise pas le transport partagé pour cette course."
        : "Cette décision n'est pas possible dans l'état actuel de la course.",
    );
  }

  const data = sharingDecisionData(trip, decision, note, new Date());
  // Guarded on the answer read above: a concurrent answer is not overwritten (and its trace not lost).
  const updated = await db.trip.updateMany({
    where: { id: trip.id, sharingStatus: trip.sharingStatus, sharingRespondedAt: trip.sharingRespondedAt },
    data,
  });
  if (updated.count === 0) return failure(CONCURRENT_CHANGE);

  revalidateTripViews();
  let message = `${SHARING_DECISION_LABELS[decision]} enregistré.`;
  if (decision === "REFUSED") {
    message += trip.shared
      ? " La course reste partagée dans le planning actuel (signalée « à réoptimiser ») : réoptimisez pour la transporter seule."
      : " Le partage ne sera plus proposé à la prochaine optimisation.";
  }
  return { ok: true, message };
}
