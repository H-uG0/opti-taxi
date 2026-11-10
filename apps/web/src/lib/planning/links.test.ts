import { describe, expect, it } from "vitest";
import { coursesTripHref, patientHref, planningTripHref, telHref } from "./links";

describe("links between the planning and the other screens", () => {
  it("opens a trip on the planning of its date", () => {
    expect(planningTripHref("2026-11-10", "cmw1")).toBe("/planning?date=2026-11-10&trip=cmw1");
  });

  it("filters Courses on the patient (by id, never by name) and the leg", () => {
    expect(coursesTripHref("2026-11-10", "cm9p1", "RETURN")).toBe("/courses?date=2026-11-10&sens=RETURN&patient=cm9p1");
    expect(coursesTripHref("2026-11-10", "cm9p2")).toBe("/courses?date=2026-11-10&patient=cm9p2");
  });

  it("opens the patient's record and calls a phone number as typed", () => {
    expect(patientHref("p/1")).toBe("/patients/p%2F1");
    expect(telHref("04 91.00 00 01")).toBe("tel:0491000001");
  });
});
