"use server";

import type { Prisma, RouteStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit, auditRead, type AuditEntry } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { errorState, type ActionResult, type FormState } from "@/lib/forms";
import { GENERATION_INCLUDE, prescriptionOn } from "@/lib/domain/trip-generation";
import { CANCELLATION_REASON_LABELS, isLateCancellation, NO_CANCELLATION, userCancellation } from "@/lib/domain/cancellation";
import { conflictLabel, restoreBlocker, tripConflicts } from "@/lib/domain/duplicates";
import { isSameEpisode } from "@/lib/domain/no-show";
import { allowedVehicleTypesFor, formatAddress, sharingAllowedFor } from "@/lib/domain/rules";
import { formatEuros } from "@/lib/labels";
import { getSettings } from "@/lib/domain/settings";
import { logError, safeErrorFields } from "@/lib/log";
import { evaluate } from "@/lib/optimizer/client";
import { isConcurrentWriteError, lockRoutesOfTrips, NOTHING_DETACHED, removeTripStops, type DetachResult } from "@/lib/planning/detach";
import {
  refreshAdvice,
  refreshCallsForReoptimization,
  refreshNotice,
  refreshRoutes,
  type RefreshOutcome,
} from "@/lib/planning/refresh-routes";
import { formatMinute, addDays, formatShortDate, fromIsoDate, isIsoDate, todayIso, tomorrowIso, toIsoDate } from "@/lib/time";
import { completeTrips, currentHorizon, inHorizon, type SkippedRecurrence } from "@/lib/trips/completion";
import { writableRange } from "@/lib/trips/horizon";
import {
  buildNewTrips,
  CANCEL_TRIP_FIELDS,
  cancelTripSchema,
  EDIT_TRIP_FIELDS,
  cancelTripsSchema,
  firstErrorMessage,
  formValues,
  generateWeekSchema,
  NEW_TRIP_FIELDS,
  parseNewTrip,
  parseTripEdit,
  prescriptionUsableOn,
  scheduleSchema,
  tollSchema,
  sharingDecisionSchema,
  tripIdSchema,
  type FieldErrors,
  type TripDestination,
  type TripPrescription,
} from "./trip-form";
import { checkScheduleFit, type ScheduleFit } from "./schedule-fit";
import { locatePlace, type LocatedPlace } from "./locate-place";
import { planTripEdit, recurrenceMoveBlocker, type EditableTrip, type TripEdit } from "./trip-edit";
import { createdTripsHref, updatedTripHref } from "./trip-notices";
import { recurrenceSchedules } from "../patients/_lib/trip-sync";
import { sharingDecisionData } from "./sharing-decision";
import { bulkCancelMessage, generationMessage } from "./trip-list";
import { canCancel, canEditTime, canRestore, keyMinuteLabel, sharingDecisionsFor, SHARING_DECISION_LABELS } from "./trip-rules";

/** Pages that show trips, route stops or route totals: refreshed after every change. */
function revalidateTripViews() {
  revalidatePath("/courses");
  revalidatePath("/arrivees-partagees");
  revalidatePath("/planning");
  revalidatePath("/chauffeur");
  revalidatePath("/tableau-de-bord");
}

function failure(message: string): ActionResult {
  return { ok: false, message };
}

/** Interactive transactions of this file: trips, route stops and their audit events. */
const TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

/** Audit event of a change on one trip. */
function tripEvent(action: AuditEntry["action"], trip: { id: string; serviceDate: Date }): AuditEntry {
  return { action, entity: "Trip", entityId: trip.id, serviceDate: toIsoDate(trip.serviceDate) };
}

// ---------------------------------------------------------------------------
// Generation of the recurring trips

/** « Générer les courses » : the feedback, and the recurrences whose sessions no prescription covers. */
export type GenerationResult = ActionResult & { skipped: SkippedRecurrence[] };

/**
 * « Générer les courses de la semaine » : the missing trips of the week, from
 * tomorrow at the earliest (a day begun or past is never filled in). Lists the
 * recurrences skipped for want of a valid prescription, with their patient.
 */
export async function generateWeekTrips(_prev: GenerationResult, formData: FormData): Promise<GenerationResult> {
  const user = await requireUser("REGULATOR");
  const parsed = generateWeekSchema.safeParse(formValues(formData, ["weekStart"]));
  if (!parsed.success) return { ...failure(firstErrorMessage(parsed.error)), skipped: [] };

  const week = { from: parsed.data.weekStart, to: addDays(parsed.data.weekStart, 6) };
  const range = writableRange(week, tomorrowIso());
  if (!range) {
    return {
      ok: false,
      message: `Semaine du ${formatShortDate(week.from)} au ${formatShortDate(week.to)} déjà passée\u00a0: les courses ne sont générées qu'à partir de demain.`,
      skipped: [],
    };
  }
  try {
    const completion = await db.$transaction((tx) => completeTrips(tx, user, range), TX_OPTIONS);
    // Patients named in the answer (no valid prescription): a read of their records.
    if (completion.skipped.length > 0) await auditRead(user, { action: "patient_list.view", entity: "Patient", entityId: null });
    if (completion.created + completion.revived > 0) revalidateTripViews();
    return { ok: true, message: generationMessage(completion, range.from, range.to), skipped: completion.skipped };
  } catch (error) {
    logError("[courses] generateWeekTrips failed", error, { weekStart: week.from });
    return { ...failure("La génération des courses a échoué. Réessayez ou contactez l'administrateur."), skipped: [] };
  }
}

/**
 * Called by the planning and trips pages once shown, for a date of the
 * horizon: creates its missing recurring trips (and brings back those the
 * application cancelled). Idempotent; a page render never writes.
 */
export async function completeDayTrips(date: string): Promise<{ changed: boolean; failed?: true }> {
  const user = await requireUser("REGULATOR");
  if (typeof date !== "string" || !isIsoDate(date)) return { changed: false };
  try {
    const horizon = await currentHorizon(db, todayIso());
    if (!inHorizon(date, horizon)) return { changed: false };
    const completion = await db.$transaction((tx) => completeTrips(tx, user, { from: date, to: date }), TX_OPTIONS);
    const changed = completion.created + completion.revived > 0;
    if (changed) revalidateTripViews();
    return { changed };
  } catch (error) {
    logError("[courses] completeDayTrips failed", error, { date });
    return { changed: false, failed: true };
  }
}

// ---------------------------------------------------------------------------
// One-off trip

/** The app's form state (lib/forms): one message per field, the typed values echoed, a new submissionId each answer. */
export type NewTripState = FormState;
export type EditTripState = FormState;

/**
 * « Nouvelle course » : one leg, or « Aller et retour » (both trips at once,
 * same day and place, two trip.create events). The list of the date opens
 * on them, with « Où la placer ? » when the day already has routes.
 */
export async function createTrip(_prev: NewTripState, formData: FormData): Promise<NewTripState> {
  const user = await requireUser("REGULATOR");
  const values = formValues(formData, NEW_TRIP_FIELDS);
  const echoedValues = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const answer = (errors: FieldErrors, message: string | null = null): NewTripState =>
    errorState(
      Object.fromEntries(Object.entries(errors).flatMap(([field, messages]) => (messages?.[0] ? [[field, messages[0]]] : []))),
      echoedValues,
      message ?? "Vérifiez les champs signalés.",
    );

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
    const free = await locatePlace(user, input.destinationAddress ?? "", input.destinationLat, input.destinationLng, {
      address: "destinationAddress",
      lat: "destinationLat",
    });
    if (!free.ok) return answer({ [free.field]: [free.message] });
    destination = { facilityId: null, ...free.place };
  }

  const trips = buildNewTrips(input, patient, prescription, destination);
  let createdIds: string[];
  try {
    createdIds = await db.$transaction(async (tx) => {
      const ids: string[] = [];
      for (const data of trips) {
        const created = await tx.trip.create({ data, select: { id: true } });
        ids.push(created.id);
      }
      await audit(
        tx,
        user,
        ids.map((id) => ({ action: "trip.create", entity: "Trip", entityId: id, serviceDate: input.serviceDate })),
      );
      return ids;
    }, TX_OPTIONS);
  } catch (error) {
    logError("[courses] createTrip failed", error, { patientId: patient.id });
    return answer({}, trips.length > 1 ? "Les courses n'ont pas pu être enregistrées. Réessayez." : "La course n'a pas pu être enregistrée. Réessayez.");
  }

  revalidateTripViews();
  // The list names the new trips: a trip of the same patient that day (same leg, or during another session) is
  // warned about there, without blocking (tripConflicts).
  redirect(createdTripsHref(input.serviceDate, createdIds));
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

const CONCURRENT_CHANGE = "La course a changé entre-temps\u00a0: rechargez la page.";

/**
 * Runs a transaction that takes a trip out of its route (and records its audit
 * event). Null when the trip changed meanwhile: the guarded update found
 * nothing (the callback returns null), or another transaction won the race on
 * the same rows.
 */
async function detachInTransaction(
  fn: (tx: Prisma.TransactionClient) => Promise<DetachResult | null>,
): Promise<DetachResult | null> {
  try {
    return await db.$transaction(fn, TX_OPTIONS);
  } catch (error) {
    if (isConcurrentWriteError(error)) {
      console.warn("[courses] trip changed by a concurrent transaction", safeErrorFields(error));
      return null;
    }
    throw error;
  }
}

/**
 * Recomputes the times and totals of the routes a trip has just left, once
 * its transaction has committed (see lib/planning/refresh-routes.ts).
 */
function refreshLeftRoutes(routeIds: readonly string[]): Promise<RefreshOutcome> {
  return refreshRoutes({ prisma: db, evaluate }, routeIds);
}

/** " " + the refresh account, or "". */
function noticeOf(refresh: RefreshOutcome): string {
  const notice = refreshNotice(refresh);
  return notice ? ` ${notice}` : "";
}

/** " " + what to do after the recomputation (re-optimize, or tell the driver on a day under way), or "". */
function adviceOf(refresh: RefreshOutcome, routeStatus: RouteStatus | null | undefined): string {
  const advice = refreshAdvice(refresh);
  if (!advice) return "";
  return ` ${advice}${refreshCallsForReoptimization(refresh) ? validatedHint(routeStatus) : ""}`;
}

/**
 * " Son co-passager voyage désormais seul." `nowAlone`: the trips left alone
 * on board; those cancelled in the same transaction (`cancelled`) are not.
 */
function aloneMessage(nowAlone: readonly string[], cancelled: readonly { id: string }[] = []): string {
  const gone = new Set(cancelled.map((t) => t.id));
  const count = new Set(nowAlone.filter((id) => !gone.has(id))).size;
  if (count === 0) return "";
  return count === 1
    ? " Son co-passager voyage désormais seul (transport non partagé)."
    : ` ${count} co-passagers voyagent désormais seuls (transport non partagé).`;
}

/** Reminder when the day's plan is validated: it must be reopened before re-optimizing. */
function validatedHint(routeStatus: RouteStatus | null | undefined): string {
  return routeStatus === "VALIDATED" ? " Le planning est validé\u00a0: rouvrez-le avant de réoptimiser." : "";
}

/** A trip the cancellation reads: its state, its route and when it is picked up (lateness). */
const CANCEL_SELECT = {
  id: true,
  status: true,
  serviceDate: true,
  direction: true,
  patientId: true,
  recurrenceId: true,
  facilityId: true,
  routeId: true,
  plannedPickupMinute: true,
  appointmentMinute: true,
  readyMinute: true,
  route: { select: { status: true } },
} satisfies Prisma.TripSelect;

type CancelledTrip = Prisma.TripGetPayload<{ select: typeof CANCEL_SELECT }>;

/** The return of the same care (same patient, day and recurrence or facility) that an outbound cancellation may take along. */
function isReturnOf(back: CancelledTrip, outbound: CancelledTrip): boolean {
  return (
    outbound.direction === "OUTBOUND" &&
    back.direction === "RETURN" &&
    back.serviceDate.getTime() === outbound.serviceDate.getTime() &&
    isSameEpisode(outbound, back)
  );
}

/**
 * « Annuler la course » : a reason is required; the cancellation keeps who,
 * when and whether it came late (less than lateCancellationHours before the
 * pickup). Cancelling an outbound trip may take the return of the same care
 * along (box ticked in the form).
 */
export async function cancelTrip(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const parsed = cancelTripSchema.safeParse(formValues(formData, CANCEL_TRIP_FIELDS));
  if (!parsed.success) return failure(firstErrorMessage(parsed.error));
  const { tripId, reason, note, returnTripId } = parsed.data;

  const [trip, back, settings] = await Promise.all([
    db.trip.findUnique({ where: { id: tripId }, select: CANCEL_SELECT }),
    returnTripId ? db.trip.findUnique({ where: { id: returnTripId }, select: CANCEL_SELECT }) : null,
    getSettings(db),
  ]);
  if (!trip) return failure("Course introuvable.");
  if (!canCancel(trip.status)) return failure("Seule une course pas encore commencée peut être annulée.");
  if (returnTripId && (!back || !isReturnOf(back, trip))) return failure("Le retour à annuler ne correspond pas à cet aller\u00a0: rechargez la page.");
  // A return already started, cancelled or closed meanwhile is left as it is: the outbound trip is still cancelled.
  const trips = back && canCancel(back.status) ? [trip, back] : [trip];

  const now = new Date();
  const fieldsOf = (t: CancelledTrip) =>
    userCancellation({
      reason,
      note: note ?? null,
      actorId: user.id,
      now,
      late: isLateCancellation({ ...t, serviceDate: toIsoDate(t.serviceDate) }, now, settings.lateCancellationHours),
    });

  // Guarded on the statuses read above so a concurrent change is not overwritten;
  // the stops are removed only when a trip really leaves its route.
  const detached = await detachInTransaction(async (tx) => {
    const result: DetachResult = { nowAlone: [], routeIds: [] };
    // The outbound and return routes locked together, in id order (no deadlock with another batch).
    await lockRoutesOfTrips(tx, trips.map((t) => t.id));
    for (const t of trips) {
      const updated = await tx.trip.updateMany({
        where: { id: t.id, status: t.status },
        data: { ...CLEARED_PLANNING, status: "CANCELLED", ...fieldsOf(t) },
      });
      // The trip asked for changed meanwhile: nothing is cancelled. A return that changed is left alone.
      if (updated.count === 0) {
        if (t === trip) return null;
        continue;
      }
      // The reason stays on the trip only: « hospitalisation » or « décès » are health data, kept out of the trail.
      await audit(tx, user, tripEvent("trip.cancel", t));
      const removed = await removeTripStops(tx, t.id);
      result.nowAlone.push(...removed.nowAlone);
      result.routeIds.push(...removed.routeIds.filter((id) => !result.routeIds.includes(id)));
    }
    return result;
  });
  if (!detached) return failure(CONCURRENT_CHANGE);

  const refresh = await refreshLeftRoutes(detached.routeIds);
  revalidateTripViews();
  const both = trips.length > 1;
  const why = ` (${CANCELLATION_REASON_LABELS[reason].toLowerCase()})`;
  const late = trips.some((t) => fieldsOf(t).lateCancellation) ? " Annulation tardive." : "";
  const routed = trips.some((t) => t.routeId !== null) || detached.routeIds.length > 0;
  if (!routed) return { ok: true, message: `${both ? "Aller et retour annulés" : "Course annulée"}${why}.${late}` };
  const left = both ? "Aller et retour annulés et retirés de leur tournée" : "Course annulée et retirée de sa tournée";
  return {
    ok: true,
    message: `${left}${why}.${late}${aloneMessage(detached.nowAlone, trips)}${noticeOf(refresh)}${adviceOf(refresh, trip.route?.status ?? back?.route?.status)}`,
  };
}

/**
 * « Annuler la sélection » : the trips ticked in the list, with one reason
 * (and note) for all, each cancelled as « Annuler la course » would (who,
 * when, late or not, out of its route) and traced on its own (trip.cancel,
 * details.bulk). A trip already started, closed or changed meanwhile is left
 * as it is and counted apart; the others are still cancelled.
 */
export async function cancelTrips(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const parsed = cancelTripsSchema.safeParse({
    tripIds: formData.getAll("tripId").filter((v): v is string => typeof v === "string"),
    reason: formData.get("reason") ?? undefined,
    note: formData.get("note") ?? undefined,
  });
  if (!parsed.success) return failure(firstErrorMessage(parsed.error));
  const { tripIds, reason, note } = parsed.data;

  const [found, settings] = await Promise.all([
    db.trip.findMany({ where: { id: { in: tripIds } }, select: CANCEL_SELECT }),
    getSettings(db),
  ]);
  const open = found.filter((t) => canCancel(t.status));
  const now = new Date();
  const fieldsOf = (t: CancelledTrip) =>
    userCancellation({
      reason,
      note: note ?? null,
      actorId: user.id,
      now,
      late: isLateCancellation({ ...t, serviceDate: toIsoDate(t.serviceDate) }, now, settings.lateCancellationHours),
    });

  // One transaction: each trip guarded on the status read above, a trip changed meanwhile is skipped.
  const cancelled: CancelledTrip[] = [];
  const detached = await detachInTransaction(async (tx) => {
    const result: DetachResult = { nowAlone: [], routeIds: [] };
    cancelled.length = 0;
    // Every route of the batch locked first, in id order: trip by trip, two batches crossing the same routes could deadlock.
    await lockRoutesOfTrips(tx, open.map((t) => t.id));
    for (const t of open) {
      const updated = await tx.trip.updateMany({
        where: { id: t.id, status: t.status },
        data: { ...CLEARED_PLANNING, status: "CANCELLED", ...fieldsOf(t) },
      });
      if (updated.count === 0) continue;
      cancelled.push(t);
      // The reason stays on the trip only, as for one trip.
      await audit(tx, user, { ...tripEvent("trip.cancel", t), details: { bulk: true } });
      const removed = await removeTripStops(tx, t.id);
      result.nowAlone.push(...removed.nowAlone);
      result.routeIds.push(...removed.routeIds.filter((id) => !result.routeIds.includes(id)));
    }
    return result;
  });
  if (!detached) return failure("Les courses ont changé entre-temps\u00a0: rechargez la page, rien n'a été annulé.");

  const refresh = await refreshLeftRoutes(detached.routeIds);
  if (cancelled.length > 0) revalidateTripViews();
  const message = bulkCancelMessage({
    cancelled: cancelled.length,
    fromRoutes: cancelled.filter((t) => t.routeId !== null).length,
    late: cancelled.filter((t) => fieldsOf(t).lateCancellation).length,
    skipped: tripIds.length - cancelled.length,
    reason: CANCELLATION_REASON_LABELS[reason].toLowerCase(),
  });
  if (cancelled.length === 0) return failure(message);
  const routed = cancelled.find((t) => t.route !== null);
  return {
    ok: true,
    // Two co-passengers both ticked: the one cancelled second is not « travelling alone ».
    message: `${message}${aloneMessage(detached.nowAlone, cancelled)}${noticeOf(refresh)}${adviceOf(refresh, routed?.route?.status)}`,
  };
}

/** What a restoration checks first, and the patient's other trips of the day (a duplicate is warned about). */
const RESTORE_SELECT = {
  id: true,
  status: true,
  serviceDate: true,
  payer: true,
  patientId: true,
  recurrenceId: true,
  facilityId: true,
  direction: true,
  appointmentMinute: true,
  readyMinute: true,
  patient: { select: { active: true } },
  recurrence: { select: { active: true } },
  prescription: { select: { validFrom: true, validTo: true } },
} satisfies Prisma.TripSelect;

/**
 * « Rétablir la course » : refused on a past date, for an inactive patient or
 * recurrence (reactivating them brings their trips back), or for a CPAM trip
 * no prescription covers; a trip of the same patient, day and leg is warned
 * about (two vehicles for one patient), without blocking.
 */
export async function restoreTrip(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const parsed = tripIdSchema.safeParse(formData.get("tripId"));
  if (!parsed.success) return failure("Course introuvable.");

  const trip = await db.trip.findUnique({ where: { id: parsed.data }, select: RESTORE_SELECT });
  if (!trip) return failure("Course introuvable.");
  if (!canRestore(trip.status)) return failure("Seule une course annulée peut être rétablie.");
  const blocker = restoreBlocker(
    {
      serviceDate: toIsoDate(trip.serviceDate),
      payer: trip.payer,
      patientActive: trip.patient.active,
      recurrenceActive: trip.recurrence ? trip.recurrence.active : null,
      prescription: trip.prescription
        ? { validFrom: toIsoDate(trip.prescription.validFrom), validTo: toIsoDate(trip.prescription.validTo) }
        : null,
    },
    todayIso(),
  );
  if (blocker) return failure(blocker);

  const detached = await detachInTransaction(async (tx) => {
    const updated = await tx.trip.updateMany({
      where: { id: trip.id, status: "CANCELLED" },
      data: { ...CLEARED_PLANNING, ...NO_CANCELLATION, status: "PLANNED" },
    });
    if (updated.count === 0) return null;
    await audit(tx, user, tripEvent("trip.restore", trip));
    // A trip cancelled elsewhere may still have stops: it starts afresh, outside any route.
    return removeTripStops(tx, trip.id);
  });
  if (!detached) return failure(CONCURRENT_CHANGE);

  const [refresh, sameDay] = await Promise.all([
    refreshLeftRoutes(detached.routeIds),
    db.trip.findMany({
      where: { patientId: trip.patientId, serviceDate: trip.serviceDate },
      select: { id: true, patientId: true, recurrenceId: true, facilityId: true, direction: true, status: true, appointmentMinute: true, readyMinute: true },
    }),
  ]);
  revalidateTripViews();
  const warning = tripConflicts({ ...trip, status: "PLANNED" }, sameDay)
    .map((conflict) => conflictLabel(conflict, trip.direction))
    .join("\u202f; ");
  return {
    ok: true,
    message: `Course rétablie\u00a0: elle sera placée à la prochaine optimisation.${noticeOf(refresh)}${
      warning ? ` Attention\u00a0: ${warning}. Vérifiez qu'il ne s'agit pas d'un doublon.` : ""
    }`,
  };
}

export async function rescheduleTrip(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
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
      appointmentMinute: true,
      readyMinute: true,
      route: { select: { status: true, vehicle: { select: { label: true } } } },
    },
  });
  if (!trip) return failure("Course introuvable.");
  if (!canEditTime(trip.status)) return failure("L'horaire d'une course commencée ou annulée ne peut plus changer.");

  const minute = parsed.data.time;
  // Same time as stored (double submit, form saved unchanged): nothing is written or traced.
  if ((trip.direction === "OUTBOUND" ? trip.appointmentMinute : trip.readyMinute) === minute) {
    return { ok: true, message: `Horaire inchangé\u00a0: ${keyMinuteLabel(trip.direction)} à ${formatMinute(minute)}.` };
  }
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

  const detached = await detachInTransaction(async (tx) => {
    const updated = await tx.trip.updateMany({
      where: { id: trip.id, status: trip.status, routeId: trip.routeId },
      data: fit.fits ? timeData : { ...timeData, ...DETACHED_PLANNING, status: "PLANNED" },
    });
    if (updated.count === 0) return null;
    await audit(tx, user, tripEvent("trip.reschedule", trip));
    return fit.fits ? NOTHING_DETACHED : removeTripStops(tx, trip.id);
  });
  if (!detached) return failure(CONCURRENT_CHANGE);

  const refresh = await refreshLeftRoutes(detached.routeIds);
  revalidateTripViews();
  const label = `${keyMinuteLabel(trip.direction)} à ${formatMinute(minute)}.`;
  if (!trip.routeId) return { ok: true, message: `${label} Pris en compte à la prochaine optimisation.` };
  const vehicle = trip.route?.vehicle.label ?? "son véhicule";
  if (fit.fits) {
    return { ok: true, message: `${label} L'horaire prévu dans la tournée de ${vehicle} reste compatible.` };
  }
  // On a day under way the date can no longer be re-optimized (replanBlockReason).
  const replace = refresh.dayStarted
    ? ` La journée a commencé\u00a0: la course ne peut plus être replacée par l'optimisation, organisez ce transport à part.${adviceOf(refresh, trip.route?.status)}`
    : ` Réoptimisez le planning pour la replacer.${validatedHint(trip.route?.status)}`;
  return {
    ok: true,
    message:
      `${label} La tournée de ${vehicle} ne tenait plus (${fit.reason})\u00a0: la course en a été retirée.` +
      `${aloneMessage(detached.nowAlone)}${noticeOf(refresh)}${replace}`,
  };
}

// ---------------------------------------------------------------------------
// « Modifier la course »

/** What « Modifier la course » reads of the trip: its state, places, route, recurrence and prescription. */
const EDIT_SELECT = {
  id: true,
  status: true,
  serviceDate: true,
  occurrenceDate: true,
  recurrenceId: true,
  direction: true,
  payer: true,
  patientId: true,
  prescriptionId: true,
  facilityId: true,
  allowedVehicleTypes: true,
  sharingAllowed: true,
  sharingStatus: true,
  shared: true,
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
  lockedVehicleId: true,
  route: { select: { status: true, vehicle: { select: { type: true, label: true } } } },
  lockedVehicle: { select: { type: true } },
  prescription: { select: { validFrom: true, validTo: true } },
  patient: { select: { address: true, postalCode: true, city: true, lat: true, lng: true } },
} satisfies Prisma.TripSelect;

type EditedTrip = Prisma.TripGetPayload<{ select: typeof EDIT_SELECT }>;

function editableTrip(trip: EditedTrip): EditableTrip {
  return {
    id: trip.id,
    status: trip.status,
    serviceDate: toIsoDate(trip.serviceDate),
    occurrenceDate: trip.occurrenceDate ? toIsoDate(trip.occurrenceDate) : null,
    recurrenceId: trip.recurrenceId,
    direction: trip.direction,
    prescriptionId: trip.prescriptionId,
    facilityId: trip.facilityId,
    allowedVehicleTypes: trip.allowedVehicleTypes,
    sharingAllowed: trip.sharingAllowed,
    sharingStatus: trip.sharingStatus,
    shared: trip.shared,
    appointmentMinute: trip.appointmentMinute,
    readyMinute: trip.readyMinute,
    pickupAddress: trip.pickupAddress,
    pickupLat: trip.pickupLat,
    pickupLng: trip.pickupLng,
    dropoffAddress: trip.dropoffAddress,
    dropoffLat: trip.dropoffLat,
    dropoffLng: trip.dropoffLng,
    oneOffAddress: trip.oneOffAddress,
    notes: trip.notes,
    routeId: trip.routeId,
    routeVehicleType: trip.route?.vehicle.type ?? null,
    lockedVehicleId: trip.lockedVehicleId,
    lockedVehicleType: trip.lockedVehicle?.type ?? null,
  };
}

/** The home side (pickup of an outbound trip, drop-off of a return) and the care side, as stored. */
function tripSides(trip: EditedTrip): { home: LocatedPlace; care: LocatedPlace } {
  const pickup = { address: trip.pickupAddress, lat: trip.pickupLat, lng: trip.pickupLng };
  const dropoff = { address: trip.dropoffAddress, lat: trip.dropoffLat, lng: trip.dropoffLng };
  return trip.direction === "OUTBOUND" ? { home: pickup, care: dropoff } : { home: dropoff, care: pickup };
}

/**
 * The place typed is the one stored: same address, and coordinates left empty
 * or as the form showed them (printed with 6 decimals): the stored point is
 * kept, so an unchanged address never takes a trip out of its route.
 */
function isStoredPlace(stored: LocatedPlace, address: string, lat: number | undefined, lng: number | undefined): boolean {
  if (address !== stored.address) return false;
  if (lat === undefined && lng === undefined) return true;
  return lat !== undefined && lng !== undefined && Math.abs(lat - stored.lat) < 1e-6 && Math.abs(lng - stored.lng) < 1e-6;
}

/**
 * The prescription a CPAM trip uses on `date` when its own does not cover it:
 * for a trip of a recurrence, the one the generation would give it that day
 * (a renewal, or the PMT it renews: lib/domain/renewal.ts). Null when none
 * does (or for a one-off trip: its own PMT is the only one it may use).
 */
async function prescriptionForMovedTrip(trip: EditedTrip, date: string): Promise<TripEdit["prescription"]> {
  if (!trip.recurrenceId) return null;
  const recurrence = await db.recurrence.findUnique({ where: { id: trip.recurrenceId }, include: GENERATION_INCLUDE });
  const found = recurrence ? prescriptionOn(recurrence, date) : null;
  if (!found) return null;
  return {
    id: found.id,
    allowedVehicleTypes: allowedVehicleTypesFor(found.mode, "CPAM"),
    sharingAllowed: sharingAllowedFor(found.sharing, trip.direction, found.mode, "CPAM"),
  };
}

/**
 * « Modifier la course » : date, address of the patient for this trip only
 * (geocoded), care facility (or the free address of a private trip), time and
 * notes. A trip of a recurrence keeps its link (it still serves the session of
 * its recurrence: trip-edit.ts). A routed trip whose date or places change
 * leaves its route, whose times and totals are then recomputed (stops kept);
 * a time change alone keeps the route when its planned stop still fits.
 * Traced trip.update (the fields changed, never their values).
 */
export async function updateTrip(tripId: string, _prev: EditTripState, formData: FormData): Promise<EditTripState> {
  const user = await requireUser("REGULATOR");
  const values = formValues(formData, EDIT_TRIP_FIELDS);
  const echoedValues = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const answer = (errors: FieldErrors, message: string | null = null): EditTripState =>
    errorState(
      Object.fromEntries(Object.entries(errors).flatMap(([field, messages]) => (messages?.[0] ? [[field, messages[0]]] : []))),
      echoedValues,
      message ?? "Vérifiez les champs signalés.",
    );

  const id = tripIdSchema.safeParse(tripId);
  const trip = id.success ? await db.trip.findUnique({ where: { id: id.data }, select: EDIT_SELECT }) : null;
  if (!trip) return answer({}, "Course introuvable\u00a0: elle a peut-être été supprimée. Rechargez la page.");
  const today = todayIso();
  const currentDate = toIsoDate(trip.serviceDate);
  if (!canEditTime(trip.status)) return answer({}, "Cette course est commencée, terminée ou annulée\u00a0: elle ne peut plus être modifiée.");
  if (currentDate < today) return answer({}, "Course d'un jour passé\u00a0: elle ne peut plus être modifiée.");

  const parsed = parseTripEdit(values, today, trip.payer);
  if (!parsed.ok) return answer(parsed.errors);
  const input = parsed.data;
  const newDate = input.serviceDate;
  const sides = tripSides(trip);

  // Care side: a facility (the current one even if deactivated since), or the free address of a private trip.
  let care: TripEdit["care"];
  if (input.facilityId) {
    const facility = await db.facility.findUnique({
      where: { id: input.facilityId },
      select: { id: true, active: true, address: true, postalCode: true, city: true, lat: true, lng: true },
    });
    if (!facility || (!facility.active && facility.id !== trip.facilityId)) {
      return answer({ facilityId: ["Établissement introuvable ou désactivé."] });
    }
    care = { facilityId: facility.id, place: { address: formatAddress(facility), lat: facility.lat, lng: facility.lng } };
  } else {
    const typed = input.careAddress ?? "";
    if (trip.facilityId === null && isStoredPlace(sides.care, typed, input.careLat, input.careLng)) {
      care = { facilityId: null, place: sides.care };
    } else {
      const located = await locatePlace(user, typed, input.careLat, input.careLng, { address: "careAddress", lat: "careLat" });
      if (!located.ok) return answer({ [located.field]: [located.message] });
      care = { facilityId: null, place: located.place };
    }
  }

  // Home side: the patient's home (as stored on the trip, or the record's when it comes back from a one-off
  // address), or an address for this trip only.
  let home: TripEdit["home"];
  if (input.homeMode === "home") {
    home = trip.oneOffAddress
      ? { place: { address: formatAddress(trip.patient), lat: trip.patient.lat, lng: trip.patient.lng }, oneOff: false }
      : { place: sides.home, oneOff: false };
  } else {
    const typed = input.homeAddress ?? "";
    if (trip.oneOffAddress && isStoredPlace(sides.home, typed, input.homeLat, input.homeLng)) {
      home = { place: sides.home, oneOff: true };
    } else {
      const located = await locatePlace(user, typed, input.homeLat, input.homeLng, { address: "homeAddress", lat: "homeLat" });
      if (!located.ok) return answer({ [located.field]: [located.message] });
      home = { place: located.place, oneOff: true };
    }
  }

  // Another day: a CPAM trip needs a prescription covering it; a trip of a recurrence never takes a day its
  // recurrence already serves.
  let prescription: TripEdit["prescription"] = null;
  if (newDate !== currentDate) {
    const own = trip.prescription;
    const covered = own !== null && toIsoDate(own.validFrom) <= newDate && newDate <= toIsoDate(own.validTo);
    if (trip.payer === "CPAM" && !covered) {
      prescription = await prescriptionForMovedTrip(trip, newDate);
      if (!prescription) {
        return answer({
          serviceDate: [
            `Aucune prescription du patient ne couvre le ${formatShortDate(newDate)}\u00a0: saisissez d'abord sa nouvelle prescription.`,
          ],
        });
      }
    }
    if (trip.recurrenceId) {
      const [recurrence, sameSession] = await Promise.all([
        db.recurrence.findUnique({
          where: { id: trip.recurrenceId },
          select: { active: true, weekdays: true, legs: true, startDate: true, endDate: true },
        }),
        db.trip.findFirst({
          where: { recurrenceId: trip.recurrenceId, occurrenceDate: fromIsoDate(newDate), direction: trip.direction, id: { not: trip.id } },
          select: { status: true, cancellationOrigin: true },
        }),
      ]);
      const blocker = recurrenceMoveBlocker(
        {
          ownSession: newDate === toIsoDate(trip.occurrenceDate ?? trip.serviceDate),
          schedulesThatDay:
            recurrence !== null &&
            recurrence.active &&
            recurrenceSchedules(
              {
                weekdays: recurrence.weekdays,
                legs: recurrence.legs,
                startDate: toIsoDate(recurrence.startDate),
                endDate: recurrence.endDate ? toIsoDate(recurrence.endDate) : null,
              },
              newDate,
              trip.direction,
            ),
          sameSessionTrip: sameSession,
        },
        formatShortDate(newDate),
      );
      if (blocker) return answer({ serviceDate: [blocker] });
    }
  }

  const plan = planTripEdit(editableTrip(trip), {
    serviceDate: newDate,
    keyMinute: input.time,
    home,
    care,
    notes: input.notes ?? null,
    prescription,
  });
  if (plan.changes.length === 0) return answer({}, "Aucune modification\u00a0: la course est déjà ainsi.");

  // The time alone changed on a routed trip: the route keeps it if its planned stop still fits (as « Modifier l'horaire »).
  let fit: ScheduleFit = { fits: true };
  if (plan.checkFit) {
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
    fit = checkScheduleFit(trip.id, input.time, planned, settings);
  }
  const detach = plan.detach || !fit.fits;
  const data: Prisma.TripUncheckedUpdateManyInput = plan.detach || fit.fits ? plan.data : { ...plan.data, ...DETACHED_PLANNING, status: "PLANNED" };

  let detached: DetachResult | null;
  try {
    detached = await detachInTransaction(async (tx) => {
      // Guarded on what was read: a trip started, cancelled, re-planned or moved meanwhile is left alone.
      const updated = await tx.trip.updateMany({
        where: { id: trip.id, status: trip.status, routeId: trip.routeId, serviceDate: trip.serviceDate },
        data,
      });
      if (updated.count === 0) return null;
      // The names of the fields changed and the dates, never an address or a note.
      await audit(tx, user, {
        action: "trip.update",
        entity: "Trip",
        entityId: trip.id,
        serviceDate: newDate,
        details: {
          fields: plan.changes,
          ...(newDate !== currentDate ? { serviceDate: { from: currentDate, to: newDate } } : {}),
          ...(detach ? { detached: true } : {}),
        },
      });
      return detach ? removeTripStops(tx, trip.id) : NOTHING_DETACHED;
    });
  } catch (error) {
    logError("[courses] updateTrip failed", error, { tripId: trip.id });
    return answer({}, "La course n'a pas pu être enregistrée. Réessayez.");
  }
  if (!detached) return answer({}, CONCURRENT_CHANGE);

  const refresh = await refreshLeftRoutes(detached.routeIds);
  revalidateTripViews();
  revalidatePath("/(regulator)/patients", "layout");
  redirect(updatedTripHref(newDate, trip.id, { changes: plan.changes, detached: detach && trip.routeId !== null, refresh }));
}

/**
 * « Péage » : tolls on this patient's invoice, outside surcharges and
 * discounts (tariff conventions). Counted in the estimated revenue from the
 * next computation of the day (optimization or route refresh).
 */
export async function setTripToll(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const parsed = tollSchema.safeParse(formValues(formData, ["tripId", "toll"]));
  if (!parsed.success) return failure(firstErrorMessage(parsed.error));
  const trip = await db.trip.findUnique({
    where: { id: parsed.data.tripId },
    select: { id: true, serviceDate: true, tollAmount: true },
  });
  if (!trip) return failure("Course introuvable.");
  const toll = parsed.data.toll;
  if (trip.tollAmount === toll) return { ok: true, message: "Péage inchangé." };
  await db.$transaction(async (tx) => {
    await tx.trip.update({ where: { id: trip.id }, data: { tollAmount: toll } });
    await audit(tx, user, { ...tripEvent("trip.toll", trip), details: { tollAmount: { from: trip.tollAmount, to: toll } } });
  });
  revalidateTripViews();
  return {
    ok: true,
    message: toll === null ? "Péage retiré." : `Péage de ${formatEuros(toll)} enregistré\u00a0: compté dans le CA au prochain calcul du planning.`,
  };
}

export async function recordSharingDecision(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const parsed = sharingDecisionSchema.safeParse(formValues(formData, ["tripId", "decision", "note"]));
  if (!parsed.success) return failure(firstErrorMessage(parsed.error));
  const { tripId, decision, note } = parsed.data;

  const trip = await db.trip.findUnique({
    where: { id: tripId },
    select: {
      id: true,
      serviceDate: true,
      status: true,
      sharingAllowed: true,
      sharingStatus: true,
      sharingProposedAt: true,
      sharingRespondedAt: true,
      // Named in the note's history line when this answer is corrected.
      sharingRespondedBy: { select: { name: true } },
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

  const data = sharingDecisionData(trip, decision, note, new Date(), user.id);
  // Guarded on the answer read above: a concurrent answer is not overwritten (and its trace not lost).
  const recorded = await db.$transaction(async (tx) => {
    const updated = await tx.trip.updateMany({
      where: { id: trip.id, sharingStatus: trip.sharingStatus, sharingRespondedAt: trip.sharingRespondedAt },
      data,
    });
    if (updated.count === 0) return false;
    await audit(tx, user, tripEvent(decision === "REFUSED" ? "trip.sharing_refuse" : "trip.sharing_accept", trip));
    return true;
  }, TX_OPTIONS);
  if (!recorded) return failure(CONCURRENT_CHANGE);

  revalidateTripViews();
  let message = `${SHARING_DECISION_LABELS[decision]} enregistré.`;
  if (decision === "REFUSED") {
    message += trip.shared
      ? " La course reste partagée dans le planning actuel (signalée «\u202fà réoptimiser\u202f»)\u00a0: réoptimisez pour la transporter seule."
      : " Le partage ne sera plus proposé à la prochaine optimisation.";
  }
  return { ok: true, message };
}
