import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { recurrencesWithoutTrip } from "./missing";

const PLACE = { address: "1 rue A", postalCode: "13001", city: "Marseille", lat: 43.3, lng: 5.4 };

function rec(id: string, overrides: { validTo?: string; lastName?: string; weekdays?: number[] } = {}) {
  return {
    id,
    patientId: `pat_${id}`,
    facilityId: "f1",
    prescriptionId: `rx_${id}`,
    label: id === "r2" ? null : "Dialyse",
    weekdays: overrides.weekdays ?? [2],
    appointmentMinute: 450,
    sessionMinutes: 240,
    legs: "BOTH" as const,
    startDate: fromIsoDate("2026-01-01"),
    endDate: null,
    active: true,
    patient: { ...PLACE, active: true, firstName: "Jean", lastName: overrides.lastName ?? `Patient${id}` },
    facility: { ...PLACE, name: "Centre de dialyse du Prado" },
    prescription: { mode: "TAP" as const, sharing: "BOTH" as const, validFrom: fromIsoDate("2026-01-01"), validTo: fromIsoDate(overrides.validTo ?? "2027-01-01") },
  };
}

describe("recurrencesWithoutTrip", () => {
  // Tuesday 10 November 2026.
  const DATE = "2026-11-10";

  it("lists the recurrences of the day that have no trip, and whether a prescription is missing", () => {
    const missing = recurrencesWithoutTrip(
      [rec("r1", { lastName: "Martin" }), rec("r2", { validTo: "2026-11-09", lastName: "Durand" }), rec("r3"), rec("r4", { weekdays: [3] })],
      new Set(["r3"]),
      DATE,
    );
    expect(missing).toEqual([
      { recurrenceId: "r2", patientId: "pat_r2", patientName: "DURAND Jean", label: "Centre de dialyse du Prado", withoutPrescription: true },
      { recurrenceId: "r1", patientId: "pat_r1", patientName: "MARTIN Jean", label: "Dialyse", withoutPrescription: false },
    ]);
  });
});
