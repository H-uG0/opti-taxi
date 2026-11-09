import { describe, expect, it } from "vitest";
import { foreignRowsWhere, simulatedRowsWhere } from "./ownership";

/**
 * Evaluates the subset of Prisma filters used by ownership.ts on a plain row,
 * with SQL's three-valued logic: a comparison with NULL is unknown (null), and
 * NOT of unknown stays unknown, so the row is not matched.
 */
type Row = { [key: string]: string | Date | null | Row[] };
type Truth = boolean | null;

function evaluate(where: object, row: Row): Truth {
  let result: Truth = true;
  const and = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a === null || b === null ? null : true);
  for (const [key, condition] of Object.entries(where)) {
    let value: Truth;
    if (key === "NOT") {
      // Prisma: NOT [a, b] = NOT a AND NOT b.
      const negated = (Array.isArray(condition) ? condition : [condition]).map((part: object): Truth => {
        const inner = evaluate(part, row);
        return inner === null ? null : !inner;
      });
      value = negated.reduce(and, true);
    } else if (key === "OR") {
      const parts = (condition as object[]).map((part) => evaluate(part, row));
      value = parts.includes(true) ? true : parts.includes(null) ? null : false;
    } else if (typeof condition === "object" && condition !== null && ("every" in condition || "none" in condition)) {
      // A to-many relation: `every` holds on each related row (true when there is none), `none` on no row.
      const related = (row[key] ?? []) as Row[];
      if ("every" in condition) value = related.every((other) => evaluate(condition.every as object, other) === true);
      else value = !related.some((other) => evaluate(condition.none as object, other) === true);
    } else {
      const cell = row[key];
      if (condition === null) value = cell === null;
      else if (condition instanceof Date) value = cell === null ? null : cell instanceof Date && cell.getTime() === condition.getTime();
      else if (typeof condition === "object" && "startsWith" in condition) {
        value = cell === null ? null : typeof cell === "string" && cell.startsWith(String(condition.startsWith));
      } else if (typeof condition === "object" && "endsWith" in condition) {
        value = cell === null ? null : typeof cell === "string" && cell.endsWith(String(condition.endsWith));
      } else if (typeof condition === "object" && "gte" in condition && "lte" in condition) {
        const { gte, lte } = condition as { gte: Date; lte: Date };
        value = cell === null ? null : cell instanceof Date && cell >= gte && cell <= lte;
      } else throw new Error(`unsupported filter ${key}`);
    }
    result = and(result, value);
  }
  return result;
}

const matches = (where: object, row: Row) => evaluate(where, row) === true;

const day = new Date("2026-10-12T00:00:00.000Z");
const otherDay = new Date("2026-10-13T00:00:00.000Z");

describe("rows the simulation owns", () => {
  const own = simulatedRowsWhere(day);
  const foreign = foreignRowsWhere(day);

  it("deletes only hist-* trips and runs of the date", () => {
    expect(matches(own.trips, { serviceDate: day, id: "hist-20261012-rec1-out" })).toBe(true);
    expect(matches(own.trips, { serviceDate: day, id: "cmvziv4z5003obers45zpe61a" })).toBe(false);
    expect(matches(own.trips, { serviceDate: day, id: "xhist-20261012" })).toBe(false);
    expect(matches(own.trips, { serviceDate: otherDay, id: "hist-20261013-rec1-out" })).toBe(false);
    expect(matches(own.runs, { serviceDate: day, id: "hist-20261012-run2" })).toBe(true);
    expect(matches(own.runs, { serviceDate: day, id: "cmvzrun" })).toBe(false);
  });

  it("deletes only its own audit events of the date, never the app's", () => {
    expect(matches(own.events, { serviceDate: day, id: "hist-20261012-ev0001" })).toBe(true);
    expect(matches(own.events, { serviceDate: day, id: "cmvzevent" })).toBe(false);
    expect(matches(own.events, { serviceDate: otherDay, id: "hist-20261013-ev0001" })).toBe(false);
    // An event of the app about no particular day (a login, an account change).
    expect(matches(own.events, { serviceDate: null, id: "cmvzevent" })).toBe(false);
  });

  it("deletes only the routes of its own runs, never a route without run", () => {
    expect(matches(own.routes, { serviceDate: day, optimizationRunId: "hist-20261012-run1" })).toBe(true);
    expect(matches(own.routes, { serviceDate: day, optimizationRunId: "cmvzrun" })).toBe(false);
    expect(matches(own.routes, { serviceDate: day, optimizationRunId: null })).toBe(false);
    expect(matches(own.routes, { serviceDate: otherDay, optimizationRunId: "hist-20261013-run1" })).toBe(false);
  });

  it("counts as foreign every row of the date it did not create, routes without run included", () => {
    expect(matches(foreign.trips, { serviceDate: day, id: "cmvziv4z5003obers45zpe61a" })).toBe(true);
    expect(matches(foreign.trips, { serviceDate: day, id: "hist-20261012-rec1-out" })).toBe(false);
    expect(matches(foreign.routes, { serviceDate: day, optimizationRunId: null })).toBe(true);
    expect(matches(foreign.routes, { serviceDate: day, optimizationRunId: "cmvzrun" })).toBe(true);
    expect(matches(foreign.routes, { serviceDate: day, optimizationRunId: "hist-20261012-run1" })).toBe(false);
    expect(matches(foreign.runs, { serviceDate: day, id: "cmvzrun" })).toBe(true);
    expect(matches(foreign.runs, { serviceDate: otherDay, id: "cmvzrun" })).toBe(false);
  });

  it("counts the app's change events of the date as foreign, never its reads nor the simulation's events", () => {
    const event = (id: string, action: string, serviceDate: Date | null = day): Row => ({ id, action, serviceDate });
    // A sharing answer corrected in « Courses » on a simulated trip: regenerating the date would contradict it.
    expect(matches(foreign.events, event("cmvzevent", "trip.sharing_refuse"))).toBe(true);
    expect(matches(foreign.events, event("cmvzevent", "trip.cancel"))).toBe(true);
    expect(matches(foreign.events, event("cmvzevent", "plan.validate"))).toBe(true);
    // A page viewed on that date changes nothing.
    expect(matches(foreign.events, event("cmvzevent", "shared_arrivals.view"))).toBe(false);
    expect(matches(foreign.events, event("cmvzevent", "roadmap.view"))).toBe(false);
    expect(matches(foreign.events, event("hist-20261012-ev0001", "trip.sharing_accept"))).toBe(false);
    expect(matches(foreign.events, event("cmvzevent", "trip.cancel", otherDay))).toBe(false);
    expect(matches(foreign.events, event("cmvzevent", "account.update", null))).toBe(false);
    expect(matches(foreignRowsWhere({ gte: day, lte: otherDay }).events, event("cmvzevent", "trip.restore", otherDay))).toBe(true);
  });

  it("finds the foreign rows of a whole period with a date range", () => {
    const period = foreignRowsWhere({ gte: day, lte: otherDay });
    expect(matches(period.trips, { serviceDate: otherDay, id: "cmvziv4z5003obers45zpe61a" })).toBe(true);
    expect(matches(period.trips, { serviceDate: otherDay, id: "hist-20261013-rec1-out" })).toBe(false);
    expect(matches(period.trips, { serviceDate: new Date("2026-10-14T00:00:00.000Z"), id: "cmvz" })).toBe(false);
    expect(matches(period.routes, { serviceDate: day, optimizationRunId: null })).toBe(true);
    expect(matches(period.runs, { serviceDate: new Date("2026-10-11T00:00:00.000Z"), id: "cmvzrun" })).toBe(false);
  });

  it("splits every row of the date into exactly one of the two sets", () => {
    const routes: Row[] = [null, "hist-20261012-run1", "cmvzrun", "hist-"].map((runId) => ({ serviceDate: day, optimizationRunId: runId }));
    for (const route of routes) expect(matches(own.routes, route) !== matches(foreign.routes, route)).toBe(true);
    const trips: Row[] = ["hist-a", "a-hist-", "HIST-a", ""].map((id) => ({ serviceDate: day, id }));
    for (const trip of trips) expect(matches(own.trips, trip) !== matches(foreign.trips, trip)).toBe(true);
  });
});

describe("rows of the date found by their id", () => {
  const own = simulatedRowsWhere(day);

  it("deletes the one-off prescriptions, absences and vehicles off the road the simulation wrote for the date", () => {
    expect(matches(own.prescriptions, { id: "hist-20261012-rx07", trips: [], recurrences: [] })).toBe(true);
    expect(matches(own.prescriptions, { id: "hist-20261012-rx07", trips: [{ id: "hist-20261012-oneoff07-out" }], recurrences: [] })).toBe(true);
    expect(matches(own.prescriptions, { id: "hist-20261013-rx07", trips: [], recurrences: [] })).toBe(false);
    expect(matches(own.prescriptions, { id: "cmvziv4z5003obers45zpe61a", trips: [], recurrences: [] })).toBe(false);
    expect(matches(own.absences, { id: "hist-20261012-abs03" })).toBe(true);
    expect(matches(own.absences, { id: "hist-20261013-abs03" })).toBe(false);
    expect(matches(own.unavailabilities, { id: "hist-20261012-una01" })).toBe(true);
    expect(matches(own.unavailabilities, { id: "cmvzuna" })).toBe(false);
  });

  it("keeps a simulated prescription that a trip or a recurrence created in the app uses", () => {
    // Tomorrow's trip created in « Nouvelle course » on a one-off PMT of a simulated day.
    const appTrip = { id: "cmvzapptrip" };
    expect(matches(own.prescriptions, { id: "hist-20261012-rx07", trips: [appTrip], recurrences: [] })).toBe(false);
    expect(matches(own.prescriptions, { id: "hist-20261012-rx07", trips: [{ id: "hist-20261012-oneoff07-out" }, appTrip], recurrences: [] })).toBe(
      false,
    );
    expect(matches(own.prescriptions, { id: "hist-20261012-rx07", trips: [], recurrences: [{ id: "cmvzrec" }] })).toBe(false);
  });
});
