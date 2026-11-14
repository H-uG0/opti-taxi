import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import {
  absenceCancellationNote,
  absenceCancellationReason,
  absenceText,
  coveredOn,
  currentAbsence,
  periodFrom,
  planningAbsenceLabel,
} from "./patient-absences";

describe("patient absences", () => {
  it("names a hospitalisation on the planning screens, and nothing more precise for the other reasons", () => {
    expect(planningAbsenceLabel("HOSPITALIZATION")).toBe("Hospitalisation");
    expect(planningAbsenceLabel("HOLIDAY")).toBe("Absence");
    expect(planningAbsenceLabel("OTHER")).toBe("Absence");
    expect(absenceCancellationReason("HOSPITALIZATION")).toBe("HOSPITALIZATION");
    expect(absenceCancellationReason("HOLIDAY")).toBe("PATIENT_ABSENCE");
  });

  it("writes the dates only as the note of the trips it cancels; the record says the reason", () => {
    const period = { startDate: "2026-11-16", endDate: "2026-11-20" };
    expect(absenceCancellationNote(period)).toBe("du 16/11/2026 au 20/11/2026");
    expect(absenceCancellationNote({ startDate: "2026-11-16", endDate: "2026-11-16" })).toBe("le 16/11/2026");
    expect(absenceText({ ...period, kind: "HOLIDAY" })).toBe("Vacances du 16/11/2026 au 20/11/2026");
  });

  it("covers its days, both ends included", () => {
    const absences = [{ startDate: fromIsoDate("2026-11-16"), endDate: fromIsoDate("2026-11-18") }];
    expect(coveredOn(absences, "2026-11-15")).toBe(false);
    expect(coveredOn(absences, "2026-11-16")).toBe(true);
    expect(coveredOn(absences, "2026-11-18")).toBe(true);
    expect(coveredOn(absences, "2026-11-19")).toBe(false);
    expect(coveredOn(undefined, "2026-11-16")).toBe(false);
  });

  it("cancels from today on only, and nothing once over", () => {
    expect(periodFrom({ startDate: "2026-11-10", endDate: "2026-11-20" }, "2026-11-14")).toEqual({
      startDate: "2026-11-14",
      endDate: "2026-11-20",
    });
    expect(periodFrom({ startDate: "2026-11-16", endDate: "2026-11-20" }, "2026-11-14")).toEqual({
      startDate: "2026-11-16",
      endDate: "2026-11-20",
    });
    expect(periodFrom({ startDate: "2026-11-01", endDate: "2026-11-13" }, "2026-11-14")).toBeNull();
  });

  it("finds the absence covering today", () => {
    const absences = [
      { id: "a", startDate: "2026-11-01", endDate: "2026-11-05" },
      { id: "b", startDate: "2026-11-12", endDate: "2026-11-16" },
    ];
    expect(currentAbsence(absences, "2026-11-14")?.id).toBe("b");
    expect(currentAbsence(absences, "2026-11-08")).toBeNull();
  });
});
