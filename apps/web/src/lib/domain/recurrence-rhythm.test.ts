import { describe, expect, it } from "vitest";
import {
  describeDaySchedules,
  describeRhythmDays,
  intervalLabel,
  nextSessionDates,
  parseDaySchedules,
  parseSessionDates,
  rhythmOccursOn,
  seriesDates,
  sessionTimesOn,
  weekdaysOfDates,
  weeksBetween,
  type Rhythm,
} from "./recurrence-rhythm";

const weekly = (overrides: Partial<Rhythm> = {}): Rhythm => ({
  weekdays: [1, 3, 5],
  startDate: "2026-11-02",
  endDate: null,
  ...overrides,
});

describe("rhythmOccursOn", () => {
  it("plans the ticked weekdays inside the period, every week by default", () => {
    expect(rhythmOccursOn(weekly(), "2026-11-04")).toBe(true);
    expect(rhythmOccursOn(weekly(), "2026-11-03")).toBe(false);
    expect(rhythmOccursOn(weekly(), "2026-11-01")).toBe(false);
    expect(rhythmOccursOn(weekly({ endDate: "2026-11-04" }), "2026-11-06")).toBe(false);
  });

  it("counts the weeks of a rhythm every N weeks from the week of the start date (Monday to Sunday)", () => {
    // Start on a Sunday: its week (from Monday 2026-11-02) is the first one.
    const everyOther = weekly({ weekdays: [1, 7], intervalWeeks: 2, startDate: "2026-11-08" });
    expect(rhythmOccursOn(everyOther, "2026-11-02")).toBe(false); // before the start date
    expect(rhythmOccursOn(everyOther, "2026-11-08")).toBe(true);
    expect(rhythmOccursOn(everyOther, "2026-11-09")).toBe(false);
    expect(rhythmOccursOn(everyOther, "2026-11-16")).toBe(true);
    expect(rhythmOccursOn(everyOther, "2026-11-22")).toBe(true);
    // Across the change of year.
    expect(rhythmOccursOn(everyOther, "2026-12-28")).toBe(true);
    expect(rhythmOccursOn(everyOther, "2027-01-04")).toBe(false);
  });

  it("plans explicit dates only, whatever the weekdays", () => {
    const dated = weekly({ sessionDates: ["2026-11-03", "2026-11-24"], startDate: "2026-11-03", endDate: "2026-11-24" });
    expect(rhythmOccursOn(dated, "2026-11-03")).toBe(true);
    expect(rhythmOccursOn(dated, "2026-11-04")).toBe(false);
    expect(rhythmOccursOn(dated, "2026-11-10")).toBe(false);
  });
});

describe("weeksBetween / nextSessionDates", () => {
  it("counts whole weeks between the weeks of two dates", () => {
    expect(weeksBetween("2026-11-08", "2026-11-09")).toBe(1);
    expect(weeksBetween("2026-11-02", "2026-11-08")).toBe(0);
    expect(weeksBetween("2026-11-02", "2027-03-29")).toBe(21);
  });

  it("lists the next sessions of a 21-day cycle", () => {
    const cycle = weekly({ weekdays: [2], intervalWeeks: 3, startDate: "2026-11-03" });
    expect(nextSessionDates(cycle, "2026-11-14", 3)).toEqual(["2026-11-24", "2026-12-15", "2027-01-05"]);
    const dated = weekly({ sessionDates: ["2026-12-01", "2026-11-10"], startDate: "2026-11-10", endDate: "2026-12-01" });
    expect(nextSessionDates(dated, "2026-11-14", 3)).toEqual(["2026-12-01"]);
  });
});

describe("day schedules", () => {
  it("reads the stored JSON, dropping what it cannot use", () => {
    expect(
      parseDaySchedules([
        { weekday: 3, appointmentMinute: 780, sessionMinutes: null },
        { weekday: 9, appointmentMinute: 600 },
        { weekday: 5, appointmentMinute: null, sessionMinutes: null },
        "x",
        { weekday: 1, appointmentMinute: 1500, sessionMinutes: 180 },
      ]),
    ).toEqual([
      { weekday: 1, appointmentMinute: null, sessionMinutes: 180 },
      { weekday: 3, appointmentMinute: 780, sessionMinutes: null },
    ]);
    expect(parseDaySchedules(null)).toEqual([]);
  });

  it("gives the weekday's own time or session length, else the common ones", () => {
    const rec = { appointmentMinute: 450, sessionMinutes: 240, daySchedules: [{ weekday: 3, appointmentMinute: 780, sessionMinutes: null }] };
    expect(sessionTimesOn(rec, "2026-11-04")).toEqual({ appointmentMinute: 780, sessionMinutes: 240 });
    expect(sessionTimesOn(rec, "2026-11-02")).toEqual({ appointmentMinute: 450, sessionMinutes: 240 });
    expect(describeDaySchedules(parseDaySchedules(rec.daySchedules))).toEqual(["Mer 13:00"]);
  });
});

describe("describing and typing a rhythm", () => {
  it("says the days in a few words", () => {
    expect(describeRhythmDays(weekly())).toBe("Lun Mer Ven");
    expect(describeRhythmDays(weekly({ weekdays: [1], intervalWeeks: 2 }))).toBe("Lun, une semaine sur deux");
    expect(intervalLabel(3)).toBe("toutes les 3 semaines");
    expect(describeRhythmDays(weekly({ sessionDates: ["2026-12-22", "2026-11-10"] }))).toBe("2 dates (10/11/2026 → 22/12/2026)");
  });

  it("reads typed dates in any order and separator, naming the invalid ones", () => {
    expect(parseSessionDates("24/11/2026\n3/11/2026, 2026-12-15 ; 24/11/2026")).toEqual({
      dates: ["2026-11-03", "2026-11-24", "2026-12-15"],
      invalid: [],
    });
    expect(parseSessionDates("30/02/2027 demain").invalid).toEqual(["30/02/2027", "demain"]);
    expect(weekdaysOfDates(["2026-11-03", "2026-11-10", "2026-11-13"])).toEqual([2, 5]);
  });

  it("adds a series of sessions every N days", () => {
    expect(seriesDates("2026-11-03", 21, 3)).toEqual(["2026-11-03", "2026-11-24", "2026-12-15"]);
    expect(seriesDates("2026-11-03", 0, 3)).toEqual([]);
  });
});
