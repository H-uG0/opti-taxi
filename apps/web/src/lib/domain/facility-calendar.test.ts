import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import {
  closedFacilitiesTitle,
  closedFacilityTrips,
  closedReasonText,
  closureCancellationNote,
  facilityClosedOn,
  holidayOn,
} from "./facility-calendar";
import { easterSunday } from "./holidays";

describe("holidayOn", () => {
  it("reads the list of « Règles de facturation » for the year it covers", () => {
    const rows = [
      { date: "2026-11-11", label: "Armistice 1918" },
      { date: "2026-12-25", label: "Noël" },
    ];
    expect(holidayOn(rows, "2026-11-11")).toEqual({ date: "2026-11-11", label: "Armistice 1918" });
    // A day removed from the list (no row) is not a holiday that year.
    expect(holidayOn(rows, "2026-11-01")).toBeNull();
  });

  it("computes the legal days, Easter-based ones included, for a year the list does not cover", () => {
    // 2027: Easter on 28 March, so Easter Monday 29/03, Ascension 06/05, Whit Monday 17/05.
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(holidayOn([], "2027-03-29")?.label).toBe("Lundi de Pâques");
    expect(holidayOn([], "2027-05-06")?.label).toBe("Ascension");
    expect(holidayOn([], "2027-05-17")?.label).toBe("Lundi de Pentecôte");
    expect(holidayOn([{ date: "2026-11-11", label: "Armistice 1918" }], "2027-11-11")?.label).toBe("Armistice 1918");
    expect(holidayOn([], "2027-03-30")).toBeNull();
  });
});

describe("facilityClosedOn", () => {
  const closures = [{ startDate: fromIsoDate("2026-12-24"), endDate: fromIsoDate("2026-12-26") }];
  const noel = { date: "2026-12-25", label: "Noël" };

  it("is closed on its dated closures, both ends included, whether it works holidays or not", () => {
    expect(facilityClosedOn({ openOnHolidays: true, closures }, "2026-12-24", null)).toEqual({
      kind: "closure",
      period: { startDate: "2026-12-24", endDate: "2026-12-26" },
    });
    expect(facilityClosedOn({ openOnHolidays: true, closures }, "2026-12-27", null)).toBeNull();
  });

  it("is closed on a public holiday unless it works them (dialysis)", () => {
    expect(facilityClosedOn({ openOnHolidays: false }, "2026-12-25", noel)).toEqual({ kind: "holiday", label: "Noël" });
    expect(facilityClosedOn({ openOnHolidays: true }, "2026-12-25", noel)).toBeNull();
    expect(facilityClosedOn({ openOnHolidays: false }, "2026-12-23", null)).toBeNull();
  });
});

describe("closedFacilityTrips", () => {
  it("groups the day's trips to a closed facility, most trips first, and leaves the others", () => {
    const radio = { id: "f1", name: "Radiothérapie", openOnHolidays: false };
    const dialysis = { id: "f2", name: "Dialyse", openOnHolidays: true };
    const clinic = { id: "f3", name: "Clinique", openOnHolidays: true, closures: [{ startDate: fromIsoDate("2026-11-11"), endDate: fromIsoDate("2026-11-11") }] };
    const groups = closedFacilityTrips(
      [
        { id: "t1", facility: radio },
        { id: "t2", facility: dialysis },
        { id: "t3", facility: clinic },
        { id: "t4", facility: radio },
        { id: "t5", facility: null },
      ],
      "2026-11-11",
      { date: "2026-11-11", label: "Armistice 1918" },
    );
    expect(groups.map((g) => [g.name, g.tripIds, closedReasonText(g.reason)])).toEqual([
      ["Radiothérapie", ["t1", "t4"], "fermé les jours fériés"],
      ["Clinique", ["t3"], "fermé le 11/11/2026"],
    ]);
  });

  it("titles the banner", () => {
    expect(closedFacilitiesTitle({ date: "2026-11-11", label: "Armistice 1918" }, 3)).toBe(
      "Jour férié (Armistice 1918) : 3 courses vers des établissements fermés",
    );
    expect(closedFacilitiesTitle(null, 1)).toBe("1 course vers un établissement fermé ce jour");
    expect(closureCancellationNote({ startDate: "2026-12-24", endDate: "2026-12-26" })).toBe("fermeture du 24/12/2026 au 26/12/2026");
  });
});
