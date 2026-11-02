import { describe, expect, it } from "vitest";
import { foreignRowsWhere, simulatedRowsWhere } from "./ownership";

/**
 * Evaluates the subset of Prisma filters used by ownership.ts on a plain row,
 * with SQL's three-valued logic: a comparison with NULL is unknown (null), and
 * NOT of unknown stays unknown, so the row is not matched.
 */
type Row = Record<string, string | Date | null>;
type Truth = boolean | null;

function evaluate(where: object, row: Row): Truth {
  let result: Truth = true;
  const and = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a === null || b === null ? null : true);
  for (const [key, condition] of Object.entries(where)) {
    let value: Truth;
    if (key === "NOT") {
      const inner = evaluate(condition as object, row);
      value = inner === null ? null : !inner;
    } else if (key === "OR") {
      const parts = (condition as object[]).map((part) => evaluate(part, row));
      value = parts.includes(true) ? true : parts.includes(null) ? null : false;
    } else {
      const cell = row[key];
      if (condition === null) value = cell === null;
      else if (condition instanceof Date) value = cell === null ? null : cell instanceof Date && cell.getTime() === condition.getTime();
      else if (typeof condition === "object" && "startsWith" in condition) {
        value = cell === null ? null : typeof cell === "string" && cell.startsWith(String(condition.startsWith));
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

  it("splits every row of the date into exactly one of the two sets", () => {
    const routes: Row[] = [null, "hist-20261012-run1", "cmvzrun", "hist-"].map((runId) => ({ serviceDate: day, optimizationRunId: runId }));
    for (const route of routes) expect(matches(own.routes, route) !== matches(foreign.routes, route)).toBe(true);
    const trips: Row[] = ["hist-a", "a-hist-", "HIST-a", ""].map((id) => ({ serviceDate: day, id }));
    for (const trip of trips) expect(matches(own.trips, trip) !== matches(foreign.trips, trip)).toBe(true);
  });
});
