import { describe, expect, it } from "vitest";
import { previousAnswerLine, SHARING_NOTE_MAX, sharingDecisionData, type SharingTrace } from "./sharing-decision";

const T0 = new Date("2026-11-02T08:00:00Z");
const T1 = new Date("2026-11-02T13:05:00Z"); // 14:05 in Paris
const T2 = new Date("2026-11-03T09:30:00Z"); // 10:30 in Paris
const T3 = new Date("2026-11-03T10:00:00Z");

const fresh: SharingTrace = { sharingStatus: "NOT_PROPOSED", sharingProposedAt: null, sharingRespondedAt: null, sharingNote: null };

describe("sharingDecisionData", () => {
  it("records a first answer and timestamps the proposal when the optimizer did not", () => {
    expect(sharingDecisionData(fresh, "ACCEPTED", undefined, T1)).toEqual({
      sharingStatus: "ACCEPTED",
      sharingProposedAt: T1,
      sharingRespondedAt: T1,
      sharingNote: null,
    });
  });

  it("keeps the optimizer's proposal time and stores the reason", () => {
    const proposed: SharingTrace = { ...fresh, sharingStatus: "PROPOSED", sharingProposedAt: T0 };
    expect(sharingDecisionData(proposed, "REFUSED", "Préfère voyager seul", T1)).toEqual({
      sharingStatus: "REFUSED",
      sharingProposedAt: T0,
      sharingRespondedAt: T1,
      sharingNote: "Préfère voyager seul",
    });
  });

  it("keeps the trace of every corrected answer, newest first", () => {
    const refused: SharingTrace = {
      sharingStatus: "REFUSED",
      sharingProposedAt: T0,
      sharingRespondedAt: T1,
      sharingNote: "Préfère voyager seul",
    };
    const accepted = sharingDecisionData(refused, "ACCEPTED", undefined, T2);
    expect(accepted).toEqual({
      sharingStatus: "ACCEPTED",
      sharingProposedAt: T0,
      sharingRespondedAt: T2,
      sharingNote: "[Réponse précédente : partage refusé le 02/11/2026 14:05]\nPréfère voyager seul",
    });

    const refusedAgain = sharingDecisionData(accepted, "REFUSED", "Fatigué", T3);
    expect(refusedAgain.sharingNote).toBe(
      [
        "Fatigué",
        "[Réponse précédente : partage accepté le 03/11/2026 10:30]",
        "[Réponse précédente : partage refusé le 02/11/2026 14:05]",
        "Préfère voyager seul",
      ].join("\n"),
    );
    expect(refusedAgain.sharingRespondedAt).toBe(T3);
  });

  it("cuts the oldest history when the note gets too long", () => {
    const long: SharingTrace = {
      sharingStatus: "REFUSED",
      sharingProposedAt: T0,
      sharingRespondedAt: T1,
      sharingNote: "x".repeat(SHARING_NOTE_MAX),
    };
    const note = sharingDecisionData(long, "ACCEPTED", "A changé d'avis", T2).sharingNote ?? "";
    expect(note).toHaveLength(SHARING_NOTE_MAX);
    expect(note.startsWith("A changé d'avis\n[Réponse précédente : partage refusé le 02/11/2026 14:05]\n")).toBe(true);
    expect(note.endsWith("…")).toBe(true);
  });

  it("formats the previous answer even without a response time", () => {
    expect(previousAnswerLine("ACCEPTED", null)).toBe("[Réponse précédente : partage accepté]");
  });
});
