import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/time";
import { coveredUntil, planStaffEvents, type StaffDayOptions, type StaffMember } from "./staff";

const people: StaffMember[] = Array.from({ length: 400 }, (_, i) => ({ id: `driver-${i}`, workDays: [1, 2, 3, 4, 5] }));
const vehicles = Array.from({ length: 400 }, (_, i) => `vehicle-${i}`);

/** Every date may be covered, nothing is stored yet. */
const open: StaffDayOptions = { mayCover: () => true, absences: [], unavailabilities: [] };

const iso = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value));

describe("absences and vehicles off the road of a simulated day", () => {
  it("are drawn per person and day, the same on every run, with ids of the date", () => {
    const monday = planStaffEvents("2026-10-12", people, vehicles, open);
    expect(monday).toEqual(planStaffEvents("2026-10-12", [...people].reverse(), [...vehicles].reverse(), open));
    expect(monday.absences.every((a) => String(a.id).startsWith("hist-20261012-abs"))).toBe(true);
    expect(monday.unavailabilities.every((u) => String(u.id).startsWith("hist-20261012-una"))).toBe(true);
    // About 5 % of the people on a Monday (a week of leave starts, a sick or training day), a few vehicles.
    expect(monday.absences.length).toBeGreaterThan(8);
    expect(monday.absences.length).toBeLessThan(40);
    expect(monday.unavailabilities.length).toBeGreaterThan(0);
  });

  it("starts a week of leave on Mondays only, and never notes a sick day", () => {
    const tuesday = planStaffEvents("2026-10-13", people, vehicles, open);
    expect(tuesday.absences.some((a) => a.kind === "LEAVE")).toBe(false);
    const monday = planStaffEvents("2026-10-12", people, vehicles, open);
    const leave = monday.absences.find((a) => a.kind === "LEAVE");
    expect(leave?.endDate).toEqual(new Date("2026-10-16T00:00:00.000Z"));
    expect([...monday.absences, ...tuesday.absences].filter((a) => a.kind === "SICK").every((a) => a.note === null)).toBe(true);
  });

  it("leaves alone people who do not work that day, and has no garage on Sundays", () => {
    const saturday = planStaffEvents("2026-10-17", people, vehicles, open);
    expect(saturday.absences).toEqual([]);
    expect(planStaffEvents("2026-10-18", people, vehicles, open).unavailabilities).toEqual([]);
  });
});

describe("dates a row may cover", () => {
  it("cuts a week of leave or a repair before the first date the run does not simulate (today, a date planned in the app)", () => {
    expect(coveredUntil("2026-10-12", 5, () => true)).toBe("2026-10-16");
    expect(coveredUntil("2026-10-12", 5, (date) => date < "2026-10-14")).toBe("2026-10-13");
    // A date left alone in the middle of the week stops the row there, even if later dates are simulated.
    expect(coveredUntil("2026-10-12", 5, (date) => date !== "2026-10-14")).toBe("2026-10-13");
    expect(coveredUntil("2026-10-12", 5, () => false)).toBe("2026-10-12");
    expect(coveredUntil("2026-10-12", 1, () => true)).toBe("2026-10-12");
  });

  it("never writes a leave or a repair reaching a date it may not cover", () => {
    const yesterday = "2026-10-13";
    const options: StaffDayOptions = { ...open, mayCover: (date) => date <= yesterday };
    const monday = planStaffEvents("2026-10-12", people, vehicles, options);
    expect(monday.absences.some((a) => a.kind === "LEAVE")).toBe(true);
    for (const row of [...monday.absences, ...monday.unavailabilities]) expect(iso(row.endDate) <= yesterday).toBe(true);
    const saturday = planStaffEvents("2026-10-17", people, vehicles, { ...open, mayCover: (date) => date <= "2026-10-17" });
    for (const row of saturday.unavailabilities) expect(iso(row.endDate)).toBe("2026-10-17");
  });
});

describe("rows already stored", () => {
  const monday = planStaffEvents("2026-10-12", people, vehicles, open);
  const onLeave = String(monday.absences.find((a) => a.kind === "LEAVE")?.driverId);
  const tuesday = planStaffEvents("2026-10-13", people, vehicles, open);

  it("give no new absence to a person already absent over its dates, whoever recorded it", () => {
    // Monday: a sick day recorded in the app on Wednesday overlaps the week of leave drawn for the person.
    const appSickDay = { rowId: "cmvzabs", ownerId: onLeave, from: "2026-10-14", to: "2026-10-14" };
    const withApp = planStaffEvents("2026-10-12", people, vehicles, { ...open, absences: [appSickDay] });
    expect(withApp.absences.some((a) => a.driverId === onLeave)).toBe(false);
    expect(withApp.absences).toHaveLength(monday.absences.length - 1);

    // Tuesday to Friday: the week of leave written on Monday by this run keeps the person out of any other draw.
    const leaveRow = { rowId: "hist-20261012-abs01", ownerId: onLeave, from: "2026-10-12", to: "2026-10-16" };
    for (let offset = 1; offset <= 4; offset++) {
      const day = addDays("2026-10-12", offset);
      const events = planStaffEvents(day, people, vehicles, { ...open, absences: [leaveRow] });
      expect(events.absences.some((a) => a.driverId === onLeave)).toBe(false);
    }
  });

  it("ignores the rows a previous simulation wrote for a later date (that date is simulated again after)", () => {
    const later = { rowId: "hist-20261014-abs02", ownerId: onLeave, from: "2026-10-14", to: "2026-10-14" };
    const events = planStaffEvents("2026-10-12", people, vehicles, { ...open, absences: [later] });
    expect(events).toEqual(monday);
  });

  it("sends no vehicle to the garage while it is already off the road", () => {
    const vehicle = String(tuesday.unavailabilities[0]?.vehicleId);
    expect(vehicle).not.toBe("undefined");
    const repair = { rowId: "hist-20261012-una01", ownerId: vehicle, from: "2026-10-12", to: "2026-10-13" };
    const events = planStaffEvents("2026-10-13", people, vehicles, { ...open, unavailabilities: [repair] });
    expect(events.unavailabilities.some((u) => u.vehicleId === vehicle)).toBe(false);
    expect(events.unavailabilities).toHaveLength(tuesday.unavailabilities.length - 1);
  });
});
