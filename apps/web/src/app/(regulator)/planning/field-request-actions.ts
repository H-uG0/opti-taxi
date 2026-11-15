"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { FIELD_REQUEST_KIND_LABELS, OPEN_TRIP_STATUSES, returnTripData } from "@/lib/domain/field-requests";
import { isSameEpisode } from "@/lib/domain/no-show";
import { sharingAllowedFor } from "@/lib/domain/rules";
import { INITIAL_ACTION_RESULT, type ActionResult } from "@/lib/forms";
import { logError } from "@/lib/log";
import { toIsoDate } from "@/lib/time";
import { cancelTrip } from "../courses/actions";

/**
 * The regulator's answer to a crew's request (DAY-05, « À traiter » of the planning): « Pris en compte » for an end of
 * session or a next session (READY_TIME, NEXT_SESSION), « Accepter » or « Refuser » for a cancellation or a return
 * asked for (CANCEL, RETURN). Accepting a cancellation cancels the trip as « Annuler la course » does (its rules, its
 * trace), with the crew's reason, and the return of an outbound with it when the regulator was asked so
 * (`withReturn`, the question says it); accepting a return creates it without a vehicle and opens « Où placer » on it.
 * A request done otherwise meanwhile (the trip cancelled, a return created by hand) is closed as accepted.
 * Each answer is traced on the trip (field_request.note, .accept, .refuse; details.requestId and details.kind).
 */
export async function resolveFieldRequest(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("REGULATOR");
  const requestId = String(formData.get("requestId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!requestId || requestId.length > 64 || !["accept", "refuse", "note"].includes(decision)) return { ok: false, message: "Demande illisible\u00a0: rechargez la page." };

  const request = await db.fieldRequest.findUnique({
    where: { id: requestId },
    select: { id: true, kind: true, status: true, tripId: true, readyMinute: true, cancellationReason: true, createdBy: { select: { name: true } } },
  });
  if (!request) return { ok: false, message: "Demande introuvable\u00a0: rechargez la page." };
  if (request.status !== "PENDING") return { ok: false, message: "Demande déjà traitée\u00a0: rechargez la page." };
  const informative = request.kind === "READY_TIME" || request.kind === "NEXT_SESSION";
  if ((decision === "note") !== informative) return { ok: false, message: "Réponse impossible pour cette demande\u00a0: rechargez la page." };

  const trip = await db.trip.findUnique({
    where: { id: request.tripId },
    select: {
      id: true,
      serviceDate: true,
      status: true,
      direction: true,
      patientId: true,
      recurrenceId: true,
      prescriptionId: true,
      facilityId: true,
      payer: true,
      allowedVehicleTypes: true,
      oneOffAddress: true,
      pickupAddress: true,
      pickupLat: true,
      pickupLng: true,
      dropoffAddress: true,
      dropoffLat: true,
      dropoffLng: true,
      prescription: { select: { mode: true, sharing: true } },
    },
  });
  if (!trip) return { ok: false, message: "Course introuvable\u00a0: rechargez la page." };
  const isoDate = toIsoDate(trip.serviceDate);
  const event = (action: "field_request.note" | "field_request.accept" | "field_request.refuse") =>
    ({ action, entity: "Trip", entityId: trip.id, serviceDate: isoDate, details: { requestId: request.id, kind: request.kind } }) as const;
  /** Closes the request if it is still pending (another regulator may have answered meanwhile). */
  const close = async (status: "NOTED" | "ACCEPTED" | "REFUSED", action: Parameters<typeof event>[0], createdTripId?: string) =>
    db.$transaction(async (tx) => {
      const updated = await tx.fieldRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: { status, resolvedAt: new Date(), resolvedById: user.id, ...(createdTripId ? { createdTripId } : {}) },
      });
      if (updated.count === 0) return false;
      await audit(tx, user, event(action));
      return true;
    });
  const label = FIELD_REQUEST_KIND_LABELS[request.kind];
  const revalidateViews = () => {
    revalidatePath("/planning");
    revalidatePath("/chauffeur");
  };

  if (decision === "note") {
    if (!(await close("NOTED", "field_request.note"))) return { ok: false, message: "Demande déjà traitée\u00a0: rechargez la page." };
    revalidateViews();
    return { ok: true, message: `${label}\u00a0: pris en compte.` };
  }
  if (decision === "refuse") {
    if (!(await close("REFUSED", "field_request.refuse"))) return { ok: false, message: "Demande déjà traitée\u00a0: rechargez la page." };
    revalidateViews();
    return { ok: true, message: `${label} refusée\u00a0: l'équipage le voit sur sa feuille de route.` };
  }

  const already = { ok: false, message: "Demande déjà traitée\u00a0: rechargez la page." } as const;
  /** The day's returns of the patient of the same care as the trip, any status but cancelled. */
  const sameCareReturns = async () => {
    const returns = await db.trip.findMany({
      where: { serviceDate: trip.serviceDate, patientId: trip.patientId, direction: "RETURN", status: { not: "CANCELLED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, patientId: true, recurrenceId: true, facilityId: true },
    });
    return returns.filter((back) => isSameEpisode(trip, back));
  };

  if (request.kind === "CANCEL") {
    // Cancelled meanwhile by another way: what the crew asked for is done.
    if (trip.status === "CANCELLED") {
      if (!(await close("ACCEPTED", "field_request.accept"))) return already;
      revalidateViews();
      return { ok: true, message: "Course déjà annulée\u00a0: demande de l'équipage close." };
    }
    // « Annuler la course » itself: the same checks (a trip already started is not cancelled), detach and trace;
    // with the outbound, its return still to do when the regulator was asked so.
    const form = new FormData();
    form.set("tripId", trip.id);
    form.set("reason", request.cancellationReason ?? "OTHER");
    form.set("note", `Demandée par l'équipage${request.createdBy?.name ? ` (${request.createdBy.name})` : ""}.`);
    if (formData.get("withReturn") === "1" && trip.direction === "OUTBOUND") {
      const back = (await sameCareReturns()).find((leg) => OPEN_TRIP_STATUSES.includes(leg.status));
      if (back) form.set("returnTripId", back.id);
    }
    // Answered first: a « Refuser » from another regulator meanwhile finds it handled. Given back when the
    // cancellation does not go through.
    const claimed = await db.fieldRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: { status: "ACCEPTED", resolvedAt: new Date(), resolvedById: user.id },
    });
    if (claimed.count === 0) return already;
    const giveBack = () =>
      db.fieldRequest.updateMany({
        where: { id: request.id, status: "ACCEPTED", resolvedById: user.id },
        data: { status: "PENDING", resolvedAt: null, resolvedById: null },
      });
    let result: ActionResult;
    try {
      result = await cancelTrip(INITIAL_ACTION_RESULT, form);
    } catch (error) {
      await giveBack();
      throw error;
    }
    if (!result.ok) {
      await giveBack();
      return result;
    }
    await audit(db, user, event("field_request.accept"));
    revalidatePath("/chauffeur");
    return { ok: true, message: `${result.message ?? "Course annulée."} Demande de l'équipage acceptée.` };
  }

  // RETURN: the trip asked for, created from the outbound left at the care place, then placed by the regulator.
  // A return created meanwhile (by hand, another request): what the crew asked for is there.
  if ((await sameCareReturns()).length > 0) {
    if (!(await close("ACCEPTED", "field_request.accept"))) return already;
    revalidateViews();
    return { ok: true, message: "Un retour est déjà prévu pour ce patient aujourd'hui\u00a0: demande de l'équipage close." };
  }
  if (request.readyMinute === null) return { ok: false, message: "Heure de fin de séance manquante\u00a0: refusez la demande et appelez l'équipage." };
  const data = returnTripData(
    {
      ...trip,
      returnSharingAllowed: sharingAllowedFor(trip.prescription?.sharing ?? null, "RETURN", trip.prescription?.mode ?? null, trip.payer),
    },
    request.readyMinute,
    `Retour demandé par l'équipage${request.createdBy?.name ? ` (${request.createdBy.name})` : ""}.`,
  );
  let createdId: string | null = null;
  try {
    createdId = await db.$transaction(async (tx) => {
      const updated = await tx.fieldRequest.updateMany({ where: { id: request.id, status: "PENDING" }, data: { status: "ACCEPTED", resolvedAt: new Date(), resolvedById: user.id } });
      if (updated.count === 0) return null;
      const created = await tx.trip.create({ data, select: { id: true } });
      await tx.fieldRequest.update({ where: { id: request.id }, data: { createdTripId: created.id } });
      await audit(tx, user, [
        { action: "trip.create", entity: "Trip", entityId: created.id, serviceDate: isoDate, details: { fieldRequest: request.id } },
        event("field_request.accept"),
      ]);
      return created.id;
    });
  } catch (error) {
    logError("[planning] accepting a return request failed", error, { requestId: request.id });
    return { ok: false, message: "Le retour n'a pas pu être créé. Réessayez." };
  }
  if (!createdId) return { ok: false, message: "Demande déjà traitée\u00a0: rechargez la page." };
  revalidatePath("/planning");
  revalidatePath("/courses");
  revalidatePath("/chauffeur");
  // The new return, selected, its places searched at once (« Où placer cette course ? »).
  redirect(`/planning?date=${isoDate}&trip=${createdId}&placer=1`);
}
