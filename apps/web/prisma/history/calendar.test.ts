import { describe, expect, it } from "vitest";
import { minuteOfServiceDay } from "@/lib/kpis";
import { isoDateOf, isoWeekday, minuteOfDay } from "@/lib/time";
import { Rng } from "../seed/random";
import {
  answerInstants,
  firstRunStart,
  handOverInstants,
  knownRefusalInstants,
  parisInstant,
  parisOffsetMinutes,
  pickSimulationDates,
  tripGenerationInstant,
  validationInstant,
} from "./calendar";

describe("parisInstant", () => {
  it("converts a local minute to UTC in summer and in winter time", () => {
    expect(parisInstant("2026-10-12", 17 * 60).toISOString()).toBe("2026-10-12T15:00:00.000Z");
    expect(parisInstant("2026-10-26", 17 * 60).toISOString()).toBe("2026-10-26T16:00:00.000Z");
    expect(parisInstant("2026-10-12", 7 * 60 + 30, 42).toISOString()).toBe("2026-10-12T05:30:42.000Z");
  });

  it("uses the offset of the target time on the day the clocks go back (25 October 2026)", () => {
    expect(parisInstant("2026-10-25", 60).toISOString()).toBe("2026-10-24T23:00:00.000Z"); // 01:00 CEST
    expect(parisInstant("2026-10-25", 17 * 60).toISOString()).toBe("2026-10-25T16:00:00.000Z"); // 17:00 CET
  });

  it("round-trips with the dashboard's minute of the service day", () => {
    for (const date of ["2026-10-09", "2026-10-24", "2026-10-26", "2026-10-31"]) {
      for (const minute of [6 * 60, 8 * 60 + 59, 12 * 60 + 1, 19 * 60 + 30]) {
        const instant = parisInstant(date, minute, 30);
        expect(isoDateOf(instant)).toBe(date);
        expect(minuteOfDay(instant)).toBe(minute);
        expect(minuteOfServiceDay(instant, date)).toBe(minute);
      }
    }
  });

  it("reads the offset of Europe/Paris", () => {
    expect(parisOffsetMinutes(new Date("2026-07-01T12:00:00Z"))).toBe(120);
    expect(parisOffsetMinutes(new Date("2026-12-01T12:00:00Z"))).toBe(60);
  });
});

describe("pickSimulationDates", () => {
  const everyDay = () => true;

  it("returns the working days before today, oldest first, never today", () => {
    // 2026-11-02 is a Monday: Saturday 31/10 back to Thursday 29/10.
    expect(pickSimulationDates("2026-11-02", 3, everyDay)).toEqual(["2026-10-29", "2026-10-30", "2026-10-31"]);
  });

  it("skips Sundays and days without trips", () => {
    const dates = pickSimulationDates("2026-11-02", 20, (date) => date !== "2026-10-27");
    expect(dates).toHaveLength(20);
    expect(dates.some((date) => isoWeekday(date) === 7)).toBe(false);
    expect(dates).not.toContain("2026-10-27");
    expect(dates.at(-1)).toBe("2026-10-31");
    expect(dates[0]).toBe("2026-10-08");
    expect([...dates].sort()).toEqual(dates);
  });

  it("stops at the lookback limit", () => {
    expect(pickSimulationDates("2026-11-02", 20, () => false, 30)).toEqual([]);
    expect(pickSimulationDates("2026-11-02", 20, everyDay, 7)).toHaveLength(6);
  });
});

describe("eve-of-day planning instants", () => {
  it("starts the first run between 16:30 and 17:00 the day before", () => {
    const rng = new Rng(1);
    for (let i = 0; i < 50; i++) {
      const start = firstRunStart("2026-10-26", rng);
      expect(isoDateOf(start)).toBe("2026-10-25");
      expect(minuteOfDay(start)).toBeGreaterThanOrEqual(16 * 60 + 30);
      expect(minuteOfDay(start)).toBeLessThanOrEqual(17 * 60);
    }
  });

  it("records known refusals before the run and answers after it, in order", () => {
    const rng = new Rng(2);
    const run = new Date("2026-10-11T15:00:00Z");
    const refusals = knownRefusalInstants(run, 3, rng);
    expect(refusals.every((at) => at < run)).toBe(true);
    const answers = answerInstants(run, 5, rng);
    expect(answers[0]!.getTime() - run.getTime()).toBeGreaterThanOrEqual(60_000);
    for (let i = 1; i < answers.length; i++) expect(answers[i]!.getTime()).toBeGreaterThan(answers[i - 1]!.getTime());
  });

  it("hands unplaced trips over one call after the other, 2 to 5 min apart", () => {
    const rng = new Rng(5);
    const after = new Date("2026-10-11T15:20:00Z");
    expect(handOverInstants(after, 0, rng)).toEqual([]);
    const calls = handOverInstants(after, 4, rng);
    expect(calls).toHaveLength(4);
    let previous = after;
    for (const at of calls) {
      const gap = (at.getTime() - previous.getTime()) / 60_000;
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(5);
      previous = at;
    }
  });

  it("validates 15 to 60 min after the first run, and after the last answer", () => {
    const rng = new Rng(3);
    const run = new Date("2026-10-11T15:00:00Z");
    for (let i = 0; i < 50; i++) {
      const minutes = (validationInstant(run, new Date(run.getTime() + 60_000), rng).getTime() - run.getTime()) / 60_000;
      expect(minutes).toBeGreaterThanOrEqual(15);
      expect(minutes).toBeLessThanOrEqual(60);
    }
    const lastAnswer = new Date(run.getTime() + 70 * 60_000);
    expect(validationInstant(run, lastAnswer, rng).getTime()).toBeGreaterThan(lastAnswer.getTime());
  });

  it("generates the week's trips on the Friday before", () => {
    const rng = new Rng(4);
    expect(isoDateOf(tripGenerationInstant("2026-10-12", rng))).toBe("2026-10-09"); // Monday
    expect(isoDateOf(tripGenerationInstant("2026-10-17", rng))).toBe("2026-10-09"); // Saturday of the same week
  });
});
