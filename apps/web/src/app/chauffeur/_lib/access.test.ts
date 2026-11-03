import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { stopAccess } from "./access";

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
