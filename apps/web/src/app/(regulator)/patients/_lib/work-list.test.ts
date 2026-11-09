import { describe, expect, it } from "vitest";
import { countByState, needsPrescriptionWork, prescriptionWorkItems, type WorkRecurrence } from "./work-list";

const TODAY = "2026-11-09";

function rec(overrides: Partial<Omit<WorkRecurrence, "patient">> & { validTo?: string; patient?: string } = {}): WorkRecurrence {
  const { validTo = "2026-11-15", patient = "MARTIN Jean", ...rest } = overrides;
  return {
    startDate: "2026-05-01",
    endDate: null,
    summary: "Lun Mer Ven 07:30 — Dialyse",
    patient: { id: `p-${patient}`, name: patient, city: "Marseille" },
    prescription: { id: `rx-${patient}-${validTo}`, mode: "TAP", validFrom: "2026-05-01", validTo },
    renewal: null,
    ...rest,
  };
}

describe("needsPrescriptionWork", () => {
  it("flags a prescription ending within 14 days (or ended) that the recurrence outlives", () => {
    expect(needsPrescriptionWork({ startDate: "2026-05-01", endDate: null }, { validTo: "2026-11-23" }, TODAY)).toBe(true);
    expect(needsPrescriptionWork({ startDate: "2026-05-01", endDate: null }, { validTo: "2026-11-24" }, TODAY)).toBe(false);
    expect(needsPrescriptionWork({ startDate: "2026-05-01", endDate: null }, { validTo: "2026-10-01" }, TODAY)).toBe(true);
  });

  it("leaves out a recurrence that stops with its prescription, or is over", () => {
    expect(needsPrescriptionWork({ startDate: "2026-05-01", endDate: "2026-11-15" }, { validTo: "2026-11-15" }, TODAY)).toBe(false);
    expect(needsPrescriptionWork({ startDate: "2026-05-01", endDate: "2026-11-01" }, { validTo: "2026-10-31" }, TODAY)).toBe(false);
    expect(needsPrescriptionWork({ startDate: "2026-05-01", endDate: "2026-12-31" }, { validTo: "2026-11-15" }, TODAY)).toBe(true);
  });
});

describe("prescriptionWorkItems", () => {
  it("lists each prescription once, expired first, then ending soon, then renewals to attach", () => {
    const renewal = { id: "rx-new", validFrom: "2026-11-16", validTo: "2027-05-15" };
    const items = prescriptionWorkItems(
      [
        rec({ patient: "DURAND Paul", renewal }),
        rec({ patient: "MARTIN Jean" }),
        rec({ patient: "MARTIN Jean", summary: "Mar 09:00 — Consultation" }),
        rec({ patient: "BLANC Rose", validTo: "2026-11-01" }),
        rec({ patient: "ROUX Lucie", validTo: "2027-02-01" }),
      ],
      TODAY,
    );
    expect(items.map((i) => [i.patient.name, i.state, i.daysLeft, i.recurrences.length])).toEqual([
      ["BLANC Rose", "expired", -8, 1],
      ["MARTIN Jean", "expiring", 6, 2],
      ["DURAND Paul", "renewed", 6, 1],
    ]);
    expect(countByState(items)).toEqual({ expired: 1, expiring: 1, renewed: 1 });
  });
});
