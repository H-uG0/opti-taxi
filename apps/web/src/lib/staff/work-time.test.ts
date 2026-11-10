import { describe, expect, it } from "vitest";
import { breakInShift, workTimeIssue, workTimeSummary, type BreakSettings } from "./work-time";

const lunch: BreakSettings = { breakWindowStartMinute: 690, breakWindowEndMinute: 840, breakMinutes: 45 };
const day = { start: 360, end: 1140 };

describe("break owed after 6 hours of work (art. L. 3121-16)", () => {
  it("clips the break window to the shift, null when the break no longer fits", () => {
    expect(breakInShift(lunch, { start: 720, end: 1140 })).toEqual({ windowStart: 720, windowEnd: 840, duration: 45 });
    expect(breakInShift(lunch, { start: 360, end: 700 })).toBeNull();
    expect(breakInShift({ ...lunch, breakMinutes: 0 }, day)).toBeNull();
  });

  it("accepts a shift of 6 hours or less without a break, and a longer one with a break of 20\u00a0min or more", () => {
    const none: BreakSettings = { breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 };
    expect(workTimeIssue(none, { start: 480, end: 840 }, "Julien Marchetti")).toBeNull();
    expect(workTimeIssue(lunch, day, "Julien Marchetti")).toBeNull();
    expect(workTimeIssue({ ...lunch, breakMinutes: 20 }, day, "Julien Marchetti")).toBeNull();
  });

  it("explains why a longer shift cannot be worked", () => {
    const none: BreakSettings = { breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 };
    expect(workTimeIssue(none, { start: 480, end: 841 }, "Julien Marchetti")).toBe(
      "Horaire de 6\u00a0h 01 sans pause\u00a0: au-delà de 6\u00a0h de travail, une pause d'au moins 20\u00a0min est obligatoire " +
        "(Code du travail, art. L. 3121-16). Réglez la pause de Julien Marchetti (fiche du chauffeur) ou raccourcissez son horaire",
    );
    expect(workTimeIssue({ ...lunch, breakMinutes: 15 }, day, "J")).toContain("avec une pause de 15\u00a0min");
    expect(workTimeIssue(lunch, { start: 860, end: 1240 }, "J")).toContain("fenêtre de pause qui ne laisse pas 45\u00a0min dans l'horaire");
  });

  it("sums the problem up in a few words for the lists", () => {
    const none: BreakSettings = { breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 };
    expect(workTimeSummary(none, { start: 360, end: 1110 })).toBe(
      "Pause de 20\u00a0min requise\u00a0: horaire de 12\u00a0h 30 sans pause (art. L. 3121-16)",
    );
    expect(workTimeSummary({ ...lunch, breakMinutes: 15 }, day)).toBe(
      "Pause de 20\u00a0min requise\u00a0: horaire de 13\u00a0h 00 avec une pause de 15\u00a0min (art. L. 3121-16)",
    );
    expect(workTimeSummary(lunch, day)).toBeNull();
    expect(workTimeSummary(none, { start: 480, end: 840 })).toBeNull();
  });
});
