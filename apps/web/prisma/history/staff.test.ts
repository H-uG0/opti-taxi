import { describe, expect, it } from "vitest";
import { planStaffEvents, type StaffMember } from "./staff";

const people: StaffMember[] = Array.from({ length: 400 }, (_, i) => ({ id: `driver-${i}`, workDays: [1, 2, 3, 4, 5] }));
const vehicles = Array.from({ length: 400 }, (_, i) => `vehicle-${i}`);

describe("absences and vehicles off the road of a simulated day", () => {
  it("are drawn per person and day, the same on every run, with ids of the date", () => {
    const monday = planStaffEvents("2026-10-12", people, vehicles);
    expect(monday).toEqual(planStaffEvents("2026-10-12", [...people].reverse(), [...vehicles].reverse()));
    expect(monday.absences.every((a) => String(a.id).startsWith("hist-20261012-abs"))).toBe(true);
    expect(monday.unavailabilities.every((u) => String(u.id).startsWith("hist-20261012-una"))).toBe(true);
    // About 5 % of the people on a Monday (a week of leave starts, a sick or training day), a few vehicles.
    expect(monday.absences.length).toBeGreaterThan(8);
    expect(monday.absences.length).toBeLessThan(40);
    expect(monday.unavailabilities.length).toBeGreaterThan(0);
  });

  it("starts a week of leave on Mondays only, and never notes a sick day", () => {
    const tuesday = planStaffEvents("2026-10-13", people, vehicles);
    expect(tuesday.absences.some((a) => a.kind === "LEAVE")).toBe(false);
    const monday = planStaffEvents("2026-10-12", people, vehicles);
    const leave = monday.absences.find((a) => a.kind === "LEAVE");
    expect(leave?.endDate).toEqual(new Date("2026-10-16T00:00:00.000Z"));
    expect([...monday.absences, ...tuesday.absences].filter((a) => a.kind === "SICK").every((a) => a.note === null)).toBe(true);
  });

  it("leaves alone people who do not work that day, and has no garage on Sundays", () => {
    const saturday = planStaffEvents("2026-10-17", people, vehicles);
    expect(saturday.absences).toEqual([]);
    expect(planStaffEvents("2026-10-18", people, vehicles).unavailabilities).toEqual([]);
  });
});
