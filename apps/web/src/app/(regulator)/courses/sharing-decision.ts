/**
 * Data written when the regulator records a patient's answer to shared transport.
 * Pure (no database access): shared by the server action and the tests.
 */
import type { SharingStatus } from "@prisma/client";
import { formatInstant } from "./trip-list";
import { SHARING_DECISION_LABELS, type SharingDecision } from "./trip-rules";

/** The note keeps the history of corrected answers; bounded so it stays readable. */
export const SHARING_NOTE_MAX = 2000;

export type SharingTrace = {
  sharingStatus: SharingStatus;
  sharingProposedAt: Date | null;
  sharingRespondedAt: Date | null;
  sharingNote: string | null;
};

export type SharingDecisionData = {
  sharingStatus: SharingDecision;
  sharingProposedAt: Date;
  sharingRespondedAt: Date;
  sharingNote: string | null;
};

function isAnswer(status: SharingStatus): status is SharingDecision {
  return status === "ACCEPTED" || status === "REFUSED";
}

/** "[Réponse précédente : partage refusé le 02/11/2026 14:05]" */
export function previousAnswerLine(status: SharingDecision, respondedAt: Date | null): string {
  const when = formatInstant(respondedAt);
  return `[Réponse précédente : ${SHARING_DECISION_LABELS[status].toLowerCase()}${when ? ` le ${when}` : ""}]`;
}

/**
 * Update of a recorded answer. An answer implies the proposal was made, now at
 * the latest. The previous note is never lost, and when the answer corrects a
 * different previous answer, that answer and its time are written above the
 * previous note: a refusal matters for the invoice (décret 2025-202,
 * art. R. 322-11-4) and must stay traceable. Newest first; the oldest lines are
 * cut when the note gets too long.
 */
export function sharingDecisionData(
  previous: SharingTrace,
  decision: SharingDecision,
  note: string | undefined,
  now: Date,
): SharingDecisionData {
  const lines: string[] = [];
  if (note) lines.push(note);
  if (isAnswer(previous.sharingStatus) && previous.sharingStatus !== decision) {
    lines.push(previousAnswerLine(previous.sharingStatus, previous.sharingRespondedAt));
  }
  if (previous.sharingNote) lines.push(previous.sharingNote);

  let sharingNote = lines.join("\n");
  if (sharingNote.length > SHARING_NOTE_MAX) sharingNote = `${sharingNote.slice(0, SHARING_NOTE_MAX - 1)}…`;

  return {
    sharingStatus: decision,
    sharingProposedAt: previous.sharingProposedAt ?? now,
    sharingRespondedAt: now,
    sharingNote: sharingNote || null,
  };
}
