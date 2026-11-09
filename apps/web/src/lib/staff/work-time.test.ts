import { describe, expect, it } from "vitest";
import { breakInShift, workTimeIssue, type BreakSettings } from "./work-time";

const lunch: BreakSettings = { breakWindowStartMinute: 690, breakWindowEndMinute: 840, breakMinutes: 45 };
const day = { start: 360, end: 1140 };

describe("break owed after 6 hours of work (art. L3121-16)", () => {
  it("clips the break window to the shift, null when the break no longer fits", () => {
    expect(breakInShift(lunch, { start: 720, end: 1140 })).toEqual({ windowStart: 720, windowEnd: 840, duration: 45 });
    expect(breakInShift(lunch, { start: 360, end: 700 })).toBeNull();
    expect(breakInShift({ ...lunch, breakMinutes: 0 }, day)).toBeNull();
  });

  it("accepts a shift of 6 hours or less without a break, and a longer one with a break of 20 min or more", () => {
    const none: BreakSettings = { breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 };
    expect(workTimeIssue(none, { start: 480, end: 840 }, "Julien Marchetti")).toBeNull();
    expect(workTimeIssue(lunch, day, "Julien Marchetti")).toBeNull();
    expect(workTimeIssue({ ...lunch, breakMinutes: 20 }, day, "Julien Marchetti")).toBeNull();
  });

  it("explains why a longer shift cannot be worked", () => {
    const none: BreakSettings = { breakWindowStartMinute: null, breakWindowEndMinute: null, breakMinutes: 0 };
    expect(workTimeIssue(none, { start: 480, end: 841 }, "Julien Marchetti")).toBe(
      "Horaire de 6 h 01 sans pause : au-delà de 6 h de travail, une pause d'au moins 20 min est obligatoire " +
        "(Code du travail, art. L3121-16). Réglez la pause de Julien Marchetti (fiche du chauffeur) ou raccourcissez son horaire",
    );
    expect(workTimeIssue({ ...lunch, breakMinutes: 15 }, day, "J")).toContain("avec une pause de 15 min");
    expect(workTimeIssue(lunch, { start: 860, end: 1240 }, "J")).toContain("fenêtre de pause qui ne laisse pas 45 min dans l'horaire");
  });
});
