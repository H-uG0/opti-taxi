import { describe, expect, it } from "vitest";
import { isNoShowReason, NO_SHOW_REASON_LABELS, NO_SHOW_REASONS, noShowAllowedFrom, noShowWaitIssue, waitedMinutes, waitStartMinute } from "./field-wait";

describe("field wait (FLD-01)", () => {
  it("counts the wait from the arrival, never before the planned start", () => {
    expect(waitStartMinute(null, 480)).toBeNull();
    expect(waitStartMinute(470, 480)).toBe(480);
    expect(waitStartMinute(485, 480)).toBe(485);
    expect(waitedMinutes(470, 480, 476)).toBe(0);
    expect(waitedMinutes(470, 480, 487)).toBe(7);
    expect(waitedMinutes(null, 480, 487)).toBeNull();
  });

  it("allows an absence at once without a minimum wait, « Arrivé » optional", () => {
    expect(noShowAllowedFrom({ arrivedMinute: null, plannedStartMinute: 480, minWaitMin: 0 })).toBeNull();
    expect(noShowWaitIssue({ arrivedMinute: null, plannedStartMinute: 480, minWaitMin: 0, atMinute: 470 })).toBeNull();
  });

  it("with a minimum wait, needs the arrival and the wait from it (or from the planned start)", () => {
    expect(noShowAllowedFrom({ arrivedMinute: null, plannedStartMinute: 480, minWaitMin: 10 })).toBe("arrival");
    expect(noShowAllowedFrom({ arrivedMinute: 472, plannedStartMinute: 480, minWaitMin: 10 })).toBe(490);
    expect(noShowAllowedFrom({ arrivedMinute: 485, plannedStartMinute: 480, minWaitMin: 10 })).toBe(495);
    expect(noShowWaitIssue({ arrivedMinute: null, plannedStartMinute: 480, minWaitMin: 10, atMinute: 500 })).toBe(
      "Attente minimale de 10 min avant une absence : touchez d'abord « Arrivé ».",
    );
    expect(noShowWaitIssue({ arrivedMinute: 485, plannedStartMinute: 480, minWaitMin: 10, atMinute: 494 })).toBe(
      "Attente minimale de 10 min avant une absence : possible à partir de 08:15.",
    );
    expect(noShowWaitIssue({ arrivedMinute: 485, plannedStartMinute: 480, minWaitMin: 10, atMinute: 495 })).toBeNull();
  });

  it("knows its reasons, each with a label", () => {
    expect(NO_SHOW_REASONS).toEqual(["NO_ANSWER", "REFUSED", "HOSPITALIZED", "FACILITY_CANCELLED", "OTHER"]);
    for (const reason of NO_SHOW_REASONS) expect(NO_SHOW_REASON_LABELS[reason]).toBeTruthy();
    expect(isNoShowReason("REFUSED")).toBe(true);
    expect(isNoShowReason("Hospitalisé au CHU")).toBe(false);
    expect(isNoShowReason(undefined)).toBe(false);
  });
});
