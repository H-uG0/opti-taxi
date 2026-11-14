import { describe, expect, it } from "vitest";
import { newPrescriptionHref, newTripHref, readTripDraft, tripDraftEntries } from "./trip-draft";

const params = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);

describe("trip draft (« Nouvelle course » through « Nouvelle prescription »)", () => {
  const draft = { direction: "BOTH" as const, time: "08:15", returnTime: "12:40", facilityId: "f2", fromCourses: true };

  it("goes to the new prescription and comes back with the same choices", () => {
    const there = newPrescriptionHref("p1", "2026-11-20", draft);
    expect(there).toBe("/patients/p1/prescriptions/nouvelle?course=2026-11-20&sens=BOTH&heure=08%3A15&fin=12%3A40&etab=f2&retour=courses");
    const back = newTripHref("p1", "2026-11-20", readTripDraft(params(there)), true);
    expect(back).toBe("/courses/nouvelle?patient=p1&date=2026-11-20&sens=BOTH&heure=08%3A15&fin=12%3A40&etab=f2&retour=courses&pmt=1");
    expect(readTripDraft(params(back))).toEqual(draft);
  });

  it("drops what does not pass its check, on read and on write", () => {
    expect(readTripDraft({ sens: "SIDEWAYS", heure: "25:00", fin: "8h", etab: "<script>", retour: "ailleurs" })).toEqual({});
    expect(readTripDraft({ sens: ["RETURN", "OUTBOUND"], heure: "07:05" })).toEqual({ direction: "RETURN", time: "07:05" });
    // A bound draft altered on the way is checked again before the redirect.
    expect(tripDraftEntries({ time: "javascript:", facilityId: "x".repeat(65), direction: "OUTBOUND" } as never)).toEqual([["sens", "OUTBOUND"]]);
    expect(newTripHref("p1", "2026-11-20", {})).toBe("/courses/nouvelle?patient=p1&date=2026-11-20");
  });
});
