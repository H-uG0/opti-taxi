/**
 * Patients' answers to shared transport, as the regulator records them in
 * « Courses » (décret 2025-202: every refusal is traced on the trip, with a
 * note). Pure, unit-tested; the written fields come from the app's own
 * sharingDecisionData.
 *
 * - A few patients never share: their refusal is recorded before the first
 *   optimization (the regulator knows them), so the optimizer never pairs them.
 * - Every other trip the optimizer shares becomes PROPOSED; the regulator calls
 *   the patient: most accept, a few refuse, which calls for a re-optimization.
 */
import type { TripDirection } from "@prisma/client";
import { sharingDecisionData, type SharingDecisionData, type SharingTrace } from "@/app/(regulator)/courses/sharing-decision";
import type { SharingDecision } from "@/app/(regulator)/courses/trip-rules";
import { unitFromKey } from "./hash";

export const SHARING_BEHAVIOUR = {
  /** Share of patients who refuse shared transport every time. */
  habitualRefusers: 0.08,
  /** Share of proposals refused on the phone by the other patients. */
  occasionalRefusal: 0.015,
  /** Share of acceptances noted as such (the note is optional in the app). */
  notedAcceptance: 0.3,
} as const;

/** A trip whose sharing answer has not been recorded yet. */
export const UNANSWERED: SharingTrace = {
  sharingStatus: "NOT_PROPOSED",
  sharingProposedAt: null,
  sharingRespondedAt: null,
  sharingNote: null,
};

const KNOWN_REFUSAL_NOTES = [
  "Refus permanent du transport partagé : préfère voyager seul (rappelé à chaque série de soins).",
  "Refus du transport partagé pour raisons médicales, signalé par le patient en début de série (refus recueilli par téléphone).",
  "Refus du transport partagé : souhaite un trajet direct, grande fatigabilité (refus recueilli par téléphone).",
] as const;

const REFUSAL_NOTES: Record<TripDirection, readonly string[]> = {
  OUTBOUND: [
    "Patient opposé au transport partagé à l'aller : ne veut pas risquer d'arriver en retard (refus recueilli par téléphone).",
    "Partage refusé à l'aller : souhaite partir directement de son domicile (refus recueilli par téléphone).",
  ],
  RETURN: [
    "Patient opposé au transport partagé au retour : fatigue après la séance (refus recueilli par téléphone).",
    "Partage refusé au retour : ne souhaite pas attendre un autre patient à la sortie (refus recueilli par téléphone).",
  ],
};

const ACCEPTANCE_NOTE = "Accord recueilli par téléphone.";

function pickFrom(items: readonly string[], key: string): string {
  return items[Math.floor(unitFromKey(key) * items.length)] ?? items[0] ?? "";
}

/** The patient refuses shared transport every time (stable for a patient). */
export function isHabitualRefuser(patientId: string): boolean {
  return unitFromKey(`habitual-refuser:${patientId}`) < SHARING_BEHAVIOUR.habitualRefusers;
}

export type SharingAnswer = { decision: SharingDecision; note: string | null };

/** Refusal of a habitual refuser, recorded before the first optimization. */
export function knownRefusal(patientId: string): SharingAnswer {
  return { decision: "REFUSED", note: pickFrom(KNOWN_REFUSAL_NOTES, `known-refusal-note:${patientId}`) };
}

/**
 * Answer to a sharing proposal, stable for a trip: a patient who refuses
 * always refuses, and the refusal is always recorded (never turned into an
 * acceptance to close the planning). A refused trip is no longer shareable,
 * so re-optimizing after each refusal converges (see planning.ts).
 */
export function sharingAnswer(trip: { id: string; patientId: string; direction: TripDirection }): SharingAnswer {
  const refuses =
    isHabitualRefuser(trip.patientId) || unitFromKey(`sharing-answer:${trip.id}`) < SHARING_BEHAVIOUR.occasionalRefusal;
  if (refuses) {
    return { decision: "REFUSED", note: pickFrom(REFUSAL_NOTES[trip.direction], `refusal-note:${trip.id}`) };
  }
  const noted = unitFromKey(`acceptance-note:${trip.id}`) < SHARING_BEHAVIOUR.notedAcceptance;
  return { decision: "ACCEPTED", note: noted ? ACCEPTANCE_NOTE : null };
}

/** Fields written for an answer, exactly as the « Courses » server action writes them. */
export function answerData(previous: SharingTrace, answer: SharingAnswer, at: Date): SharingDecisionData {
  return sharingDecisionData(previous, answer.decision, answer.note ?? undefined, at);
}
