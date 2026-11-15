/**
 * What « À traiter » offers on a crew's cancellation or return request (DAY-05): « Clore » when it was done otherwise
 * meanwhile, else « Annuler la course » — with its return, for an outbound, when « Annuler la course » of the trips
 * list would tick « Annuler aussi le retour » for that reason — or « Créer le retour ». Pure: shared by the board and
 * its tests.
 */
import type { TripStatus } from "@prisma/client";
import { FIELD_CANCEL_REASON_LABELS, OPEN_TRIP_STATUSES, type FieldRequestView } from "@/lib/domain/field-requests";
import type { TripView } from "@/lib/planning/types";
import { formatMinute } from "@/lib/time";
import { RETURN_GOES_TOO } from "../courses/trip-rules";

export type RequestAnswer =
  | { kind: "settled"; label: string }
  | { kind: "cancel"; withReturn: boolean; label: string; question: string; confirmLabel: string }
  | { kind: "return" };

export function requestAnswer(args: {
  request: Pick<FieldRequestView, "kind" | "cancellationReason">;
  trip: Pick<TripView, "direction" | "patientName"> | undefined;
  /** The trip's status now (live poll): a trip cancelled meanwhile is no longer among the day's trips. */
  status: TripStatus | null;
  /** The patient's other leg the same day (the return of an outbound, the outbound of a return). */
  otherLeg: Pick<TripView, "direction" | "status" | "readyMinute"> | undefined;
}): RequestAnswer {
  const { request, trip, status, otherLeg } = args;
  if (request.kind === "CANCEL" && status === "CANCELLED") return { kind: "settled", label: "Clore la demande (course déjà annulée)" };
  if (request.kind === "RETURN" && otherLeg && otherLeg.status !== "CANCELLED") return { kind: "settled", label: "Clore la demande (retour déjà prévu)" };
  if (request.kind !== "CANCEL") return { kind: "return" };
  const reason = request.cancellationReason && request.cancellationReason in FIELD_CANCEL_REASON_LABELS ? FIELD_CANCEL_REASON_LABELS[request.cancellationReason as keyof typeof FIELD_CANCEL_REASON_LABELS] : null;
  const name = trip?.patientName ?? "ce patient";
  const why = reason ? ` (${reason.toLowerCase()})` : "";
  const openReturn = trip?.direction === "OUTBOUND" && otherLeg?.direction === "RETURN" && OPEN_TRIP_STATUSES.includes(otherLeg.status) ? otherLeg : null;
  if (openReturn && request.cancellationReason !== null && RETURN_GOES_TOO.has(request.cancellationReason)) {
    return {
      kind: "cancel",
      withReturn: true,
      label: "Annuler l'aller et le retour",
      question: `Annuler l'aller et le retour de ${name}${why} ? Ils sortent de leur tournée.`,
      confirmLabel: "Oui, annuler l'aller et le retour",
    };
  }
  return {
    kind: "cancel",
    withReturn: false,
    label: "Annuler la course",
    question: openReturn
      ? `Annuler l'aller de ${name}${why} ? Il sort de sa tournée ; le retour (fin de séance ${formatMinute(openReturn.readyMinute)}) reste prévu.`
      : `Annuler la course de ${name}${why} ? Elle sort de sa tournée.`,
    confirmLabel: "Oui, annuler la course",
  };
}
