import { describe, expect, it } from "vitest";
import { answerData, isHabitualRefuser, knownRefusal, SHARING_BEHAVIOUR, sharingAnswer, UNANSWERED } from "./sharing";

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe("sharing answers", () => {
  it("makes a stable, small share of patients habitual refusers", () => {
    const patients = ids("patient-", 4000);
    const share = patients.filter(isHabitualRefuser).length / patients.length;
    expect(share).toBeGreaterThan(SHARING_BEHAVIOUR.habitualRefusers - 0.02);
    expect(share).toBeLessThan(SHARING_BEHAVIOUR.habitualRefusers + 0.02);
    expect(patients.filter(isHabitualRefuser)).toEqual(patients.filter(isHabitualRefuser));
  });

  it("has most proposals accepted and a few refused, with a note matching the leg", () => {
    const patient = ids("p", 4000).find((id) => !isHabitualRefuser(id)) ?? "p";
    const answers = ids("trip-", 4000).map((id, i) =>
      sharingAnswer({ id, patientId: patient, direction: i % 2 === 0 ? "OUTBOUND" : "RETURN" }),
    );
    const refused = answers.filter((a) => a.decision === "REFUSED");
    expect(refused.length / answers.length).toBeGreaterThan(0.007);
    expect(refused.length / answers.length).toBeLessThan(0.03);
    expect(refused.every((a) => a.note && /refus/i.test(a.note))).toBe(true);
    expect(answers.filter((a) => a.decision === "ACCEPTED").every((a) => a.note === null || a.note.startsWith("Accord"))).toBe(true);
  });

  it("is stable for a trip: a refusal is always recorded as a refusal, with its note", () => {
    const refuser = ids("p", 4000).find(isHabitualRefuser) ?? "p";
    const trip = { id: "trip-1", patientId: refuser, direction: "RETURN" as const };
    expect(sharingAnswer(trip)).toEqual(sharingAnswer(trip));
    expect(sharingAnswer(trip).decision).toBe("REFUSED");
    expect(sharingAnswer(trip).note).toMatch(/retour/);
    // An occasional refusal is just as stable: asking again (next round) gives the same refusal.
    const accepting = ids("p", 4000).find((id) => !isHabitualRefuser(id)) ?? "p";
    const occasional = ids("trip-", 4000)
      .map((id) => ({ id, patientId: accepting, direction: "OUTBOUND" as const }))
      .filter((t) => sharingAnswer(t).decision === "REFUSED");
    expect(occasional.length).toBeGreaterThan(0);
    for (const t of occasional) expect(sharingAnswer(t).note).toMatch(/aller/);
  });

  it("writes the fields of the « Courses » action", () => {
    const at = new Date("2026-10-11T15:10:00Z");
    const refusal = knownRefusal("patient-1");
    expect(answerData(UNANSWERED, refusal, at)).toEqual({
      sharingStatus: "REFUSED",
      sharingProposedAt: at,
      sharingRespondedAt: at,
      sharingNote: refusal.note,
    });
    const proposedAt = new Date("2026-10-11T15:00:00Z");
    const proposed = { ...UNANSWERED, sharingStatus: "PROPOSED" as const, sharingProposedAt: proposedAt };
    expect(answerData(proposed, { decision: "ACCEPTED", note: null }, at)).toEqual({
      sharingStatus: "ACCEPTED",
      sharingProposedAt: proposedAt,
      sharingRespondedAt: at,
      sharingNote: null,
    });
  });
});
