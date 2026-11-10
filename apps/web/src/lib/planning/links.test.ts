import { describe, expect, it } from "vitest";
import { coursesTripHref, patientHref, planningTripHref, telHref } from "./links";

describe("links between the planning and the other screens", () => {
  it("opens a trip on the planning of its date", () => {
    expect(planningTripHref("2026-11-10", "cmw1")).toBe("/planning?date=2026-11-10&trip=cmw1");
  });

  it("filters Courses on the patient and the leg", () => {
    expect(coursesTripHref("2026-11-10", "Hélène Martin", "RETURN")).toBe("/courses?date=2026-11-10&sens=RETURN&q=H%C3%A9l%C3%A8ne+Martin");
    expect(coursesTripHref("2026-11-10", "Paul Durand")).toBe("/courses?date=2026-11-10&q=Paul+Durand");
  });

  it("opens the patient's record and calls a phone number as typed", () => {
    expect(patientHref("p/1")).toBe("/patients/p%2F1");
    expect(telHref("04 91.00 00 01")).toBe("tel:0491000001");
  });
});
