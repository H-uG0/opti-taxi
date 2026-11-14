import { describe, expect, it } from "vitest";
import { closedFacilitiesNoteProps } from "./closed-facilities";

describe("closedFacilitiesNoteProps", () => {
  it("counts the trips of every facility and says why each is closed", () => {
    expect(
      closedFacilitiesNoteProps({
        holiday: { date: "2026-11-11", label: "Armistice 1918" },
        groups: [
          { facilityId: "f1", name: "Radiothérapie", reason: { kind: "holiday", label: "Armistice 1918" }, tripIds: ["t1", "t2"] },
          { facilityId: "f3", name: "Clinique", reason: { kind: "closure", period: { startDate: "2026-11-10", endDate: "2026-11-12" } }, tripIds: ["t3"] },
        ],
      }),
    ).toEqual({
      title: "Jour férié (Armistice 1918) : 3 courses vers des établissements fermés",
      lines: [
        { facilityId: "f1", name: "Radiothérapie", reason: "fermé les jours fériés", count: 2 },
        { facilityId: "f3", name: "Clinique", reason: "fermé du 10/11/2026 au 12/11/2026", count: 1 },
      ],
    });
  });
});
