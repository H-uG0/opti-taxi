import { describe, expect, it } from "vitest";
import {
  canCancel,
  canEditTime,
  canRestore,
  keyMinute,
  keyMinuteLabel,
  prescriptionValidOn,
  sharingConflict,
  sharingDecisionsFor,
} from "./trip-rules";

describe("keyMinute", () => {
  it("uses the appointment for an outbound leg and the end of session for a return leg", () => {
    expect(keyMinute({ direction: "OUTBOUND", appointmentMinute: 450, readyMinute: 690 })).toBe(450);
    expect(keyMinute({ direction: "RETURN", appointmentMinute: 450, readyMinute: 690 })).toBe(690);
    expect(keyMinute({ direction: "RETURN", appointmentMinute: 450, readyMinute: null })).toBeNull();
    expect(keyMinuteLabel("OUTBOUND")).toBe("RDV");
    expect(keyMinuteLabel("RETURN")).toBe("Fin de séance");
  });
});

describe("row actions", () => {
  it("cancels and reschedules only trips that have not started", () => {
    expect(canCancel("PLANNED")).toBe(true);
    expect(canCancel("ASSIGNED")).toBe(true);
    expect(canCancel("PICKED_UP")).toBe(false);
    expect(canCancel("CANCELLED")).toBe(false);
    expect(canEditTime("ASSIGNED")).toBe(true);
    expect(canEditTime("DROPPED_OFF")).toBe(false);
  });

  it("restores only cancelled trips", () => {
    expect(canRestore("CANCELLED")).toBe(true);
    expect(canRestore("PLANNED")).toBe(false);
    expect(canRestore("NO_SHOW")).toBe(false);
  });
});

describe("sharingDecisionsFor", () => {
  const base = { sharingAllowed: true, status: "PLANNED" as const };

  it("never offers a decision on a trip that is not eligible", () => {
    expect(sharingDecisionsFor({ ...base, sharingStatus: "NOT_ELIGIBLE" })).toEqual([]);
    expect(sharingDecisionsFor({ ...base, sharingAllowed: false, sharingStatus: "NOT_PROPOSED" })).toEqual([]);
    expect(sharingDecisionsFor({ ...base, sharingAllowed: false, sharingStatus: "PROPOSED" })).toEqual([]);
  });

  it("offers no decision on a cancelled trip", () => {
    expect(sharingDecisionsFor({ ...base, status: "CANCELLED", sharingStatus: "PROPOSED" })).toEqual([]);
  });

  it("offers the patient's answers, then the opposite answer as a correction; never a manual proposal", () => {
    expect(sharingDecisionsFor({ ...base, sharingStatus: "NOT_PROPOSED" })).toEqual(["ACCEPTED", "REFUSED"]);
    expect(sharingDecisionsFor({ ...base, sharingStatus: "PROPOSED" })).toEqual(["ACCEPTED", "REFUSED"]);
    expect(sharingDecisionsFor({ ...base, sharingStatus: "ACCEPTED" })).toEqual(["REFUSED"]);
    expect(sharingDecisionsFor({ ...base, sharingStatus: "REFUSED" })).toEqual(["ACCEPTED"]);
  });
});

describe("sharingConflict", () => {
  const base = { shared: true, status: "ASSIGNED" as const, sharingAllowed: true };

  it("flags a trip still shared in the plan after a refusal", () => {
    expect(sharingConflict({ ...base, sharingStatus: "REFUSED" })).toBe(true);
    expect(sharingConflict({ ...base, sharingAllowed: false, sharingStatus: "NOT_ELIGIBLE" })).toBe(true);
  });

  it("does not flag shareable, unshared or cancelled trips", () => {
    expect(sharingConflict({ ...base, sharingStatus: "PROPOSED" })).toBe(false);
    expect(sharingConflict({ ...base, sharingStatus: "ACCEPTED" })).toBe(false);
    expect(sharingConflict({ ...base, shared: false, sharingStatus: "REFUSED" })).toBe(false);
    expect(sharingConflict({ ...base, status: "CANCELLED", sharingStatus: "REFUSED" })).toBe(false);
  });
});

describe("prescriptionValidOn", () => {
  it("includes both bounds", () => {
    const p = { validFrom: "2026-11-01", validTo: "2026-11-30" };
    expect(prescriptionValidOn(p, "2026-11-01")).toBe(true);
    expect(prescriptionValidOn(p, "2026-11-30")).toBe(true);
    expect(prescriptionValidOn(p, "2026-10-31")).toBe(false);
    expect(prescriptionValidOn(p, "2026-12-01")).toBe(false);
  });
});
