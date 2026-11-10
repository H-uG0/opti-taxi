/**
 * Data written when the regulator records a patient's answer to shared transport.
 * Pure (no database access): shared by the server action and the tests.
 */
import type { SharingStatus } from "@prisma/client";
import { formatDateTime } from "@/lib/time";
import { SHARING_DECISION_LABELS, type SharingDecision } from "./trip-rules";

/** The note keeps the history of corrected answers; bounded so it stays readable. */
export const SHARING_NOTE_MAX = 2000;

export type SharingTrace = {
  sharingStatus: SharingStatus;
  sharingProposedAt: Date | null;
  sharingRespondedAt: Date | null;
  sharingNote: string | null;
  /** Account that recorded the current answer (null when unknown). */
  sharingRespondedBy?: { name: string } | null;
};

export type SharingDecisionData = {
  sharingStatus: SharingDecision;
  sharingProposedAt: Date;
  sharingRespondedAt: Date;
  /**
   * Account that recorded this answer, always written: null when unknown, so a
   * corrected answer never keeps the previous recorder's id.
   */
  sharingRespondedById: string | null;
  sharingNote: string | null;
};

function isAnswer(status: SharingStatus): status is SharingDecision {
  return status === "ACCEPTED" || status === "REFUSED";
}

/** "[Réponse précédente : partage refusé par Marie Durand le 02/11/2026 à 14:05]": stored, so with its year. */
export function previousAnswerLine(status: SharingDecision, respondedAt: Date | null, respondedByName?: string | null): string {
  const when = respondedAt ? formatDateTime(respondedAt, undefined, "always") : null;
  const by = respondedByName?.trim();
  // Author before date, as the traces shown next to the answer (lib/record-trace).
  return `[Réponse précédente\u00a0: ${SHARING_DECISION_LABELS[status].toLowerCase()}${by ? ` par ${by}` : ""}${when ? ` le ${when}` : ""}]`;
}

/**
 * Update of a recorded answer, by the account `respondedById` (the signed-in
 * regulator in the « Courses » action, the history's regulator in the generated
 * history; null only when no account is known). An answer
 * implies the proposal was made, now at the latest. The previous note is never
 * lost, and when the answer corrects a different previous answer, that answer,
 * its time and who recorded it are written above the previous note: a refusal
 * matters for the invoice (décret 2025-202, art. R. 322-11-4) and must stay
 * traceable. Newest first; the oldest lines are cut when the note gets too long.
 */
export function sharingDecisionData(
  previous: SharingTrace,
  decision: SharingDecision,
  note: string | undefined,
  now: Date,
  respondedById: string | null,
): SharingDecisionData {
  const lines: string[] = [];
  if (note) lines.push(note);
  if (isAnswer(previous.sharingStatus) && previous.sharingStatus !== decision) {
    lines.push(previousAnswerLine(previous.sharingStatus, previous.sharingRespondedAt, previous.sharingRespondedBy?.name));
  }
  if (previous.sharingNote) lines.push(previous.sharingNote);

  let sharingNote = lines.join("\n");
  if (sharingNote.length > SHARING_NOTE_MAX) sharingNote = `${sharingNote.slice(0, SHARING_NOTE_MAX - 1)}…`;

  return {
    sharingStatus: decision,
    sharingProposedAt: previous.sharingProposedAt ?? now,
    sharingRespondedAt: now,
    sharingRespondedById: respondedById,
    sharingNote: sharingNote || null,
  };
}
