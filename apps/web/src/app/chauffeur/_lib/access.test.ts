import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { lateEntryAccess, lateEntryDates, stopAccess } from "./access";

const TODAY = "2026-11-03";
const route = (overrides: Partial<{ driverId: string | null; crewMateId: string | null; serviceDate: Date }> = {}) => ({
  driverId: "drv_1",
  crewMateId: "drv_2",
  serviceDate: fromIsoDate(TODAY),
  ...overrides,
});

describe("stopAccess", () => {
  it("lets the driver and the crew mate record today's stops", () => {
    expect(stopAccess(route(), "drv_1", TODAY)).toBe("ok");
    expect(stopAccess(route(), "drv_2", TODAY)).toBe("ok");
    expect(stopAccess(route({ crewMateId: null }), "drv_1", TODAY)).toBe("ok");
  });

  it("refuses another driver, also on a route without crew mate or without driver", () => {
    expect(stopAccess(route(), "drv_3", TODAY)).toBe("not-yours");
    expect(stopAccess(route({ crewMateId: null }), "drv_3", TODAY)).toBe("not-yours");
    expect(stopAccess(route({ driverId: null, crewMateId: null }), "drv_3", TODAY)).toBe("not-yours");
    // A blank driver id never matches a missing crew member.
    expect(stopAccess(route({ driverId: null, crewMateId: null }), "", TODAY)).toBe("not-yours");
  });

  it("refuses yesterday's and tomorrow's routes", () => {
    expect(stopAccess(route({ serviceDate: fromIsoDate("2026-11-02") }), "drv_1", TODAY)).toBe("wrong-day");
    expect(stopAccess(route({ serviceDate: fromIsoDate("2026-11-04") }), "drv_2", TODAY)).toBe("wrong-day");
  });

  it("checks the crew before the date: another driver learns nothing about the day", () => {
    expect(stopAccess(route({ serviceDate: fromIsoDate("2026-11-02") }), "drv_3", TODAY)).toBe("not-yours");
  });
});

describe("« Fin de tournée »: the days still open (FLD-02)", () => {
  // Tuesday 3 November 2026, Paris is UTC+1.
  it("keeps the day before open until 03:00, today always", () => {
    expect(lateEntryDates(new Date("2026-11-03T01:59:00.000Z"))).toEqual(["2026-11-02", "2026-11-03"]);
    expect(lateEntryDates(new Date("2026-11-03T02:00:00.000Z"))).toEqual(["2026-11-03"]);
    expect(lateEntryDates(new Date("2026-11-03T21:00:00.000Z"))).toEqual(["2026-11-03"]);
  });

  it("lets the crew enter on those days only, its own routes only", () => {
    const night = new Date("2026-11-03T01:00:00.000Z");
    expect(lateEntryAccess(route({ serviceDate: fromIsoDate("2026-11-02") }), "drv_2", night)).toBe("ok");
    expect(lateEntryAccess(route({ serviceDate: fromIsoDate("2026-11-01") }), "drv_2", night)).toBe("wrong-day");
    expect(lateEntryAccess(route({ serviceDate: fromIsoDate("2026-11-02") }), "drv_3", night)).toBe("not-yours");
    expect(lateEntryAccess(route({ serviceDate: fromIsoDate("2026-11-02") }), "drv_1", new Date("2026-11-03T08:00:00.000Z"))).toBe("wrong-day");
  });
});

