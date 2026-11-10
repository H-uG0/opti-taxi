import { beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  formatDateTime,
  formatDayDate,
  formatDuration,
  formatLongDate,
  formatMinute,
  formatShortDate,
  formatTimeOn,
  fromIsoDate,
  isIsoDate,
  isoDateOf,
  isoWeekday,
  minuteOfDay,
  parseMinute,
  startOfIsoWeek,
  todayIso,
  toIsoDate,
  tomorrowIso,
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
} from "./time";

// The first Date#toISOString() of a test worker can take several seconds on a slow
// Windows machine (4-7 s observed): pay it once here, outside the per-test timeout.
beforeAll(() => {
  new Date(0).toISOString();
}, 60_000);

describe("formatMinute", () => {
  it("formats minutes since midnight as HH:MM", () => {
    expect(formatMinute(0)).toBe("00:00");
    expect(formatMinute(450)).toBe("07:30");
    expect(formatMinute(725)).toBe("12:05");
    expect(formatMinute(1439)).toBe("23:59");
  });

  it("wraps past 24 h into the next days", () => {
    expect(formatMinute(1440)).toBe("00:00 (+1)");
    expect(formatMinute(1510)).toBe("01:10 (+1)");
    expect(formatMinute(2 * 1440 + 5)).toBe("00:05 (+2)");
  });

  it("marks negative minutes as the previous day", () => {
    expect(formatMinute(-30)).toBe("23:30 (-1)");
    expect(formatMinute(-1440)).toBe("00:00 (-1)");
  });

  it("rounds fractional minutes instead of printing decimals", () => {
    expect(formatMinute(450.4)).toBe("07:30");
    expect(formatMinute(450.6)).toBe("07:31");
    expect(formatMinute(1439.7)).toBe("00:00 (+1)");
  });

  it("shows a dash when there is no time", () => {
    expect(formatMinute(null)).toBe("—");
    expect(formatMinute(undefined)).toBe("—");
    expect(formatMinute(Number.NaN)).toBe("—");
  });
});

describe("parseMinute", () => {
  it("parses HH:MM and H:MM", () => {
    expect(parseMinute("07:30")).toBe(450);
    expect(parseMinute("7:30")).toBe(450);
    expect(parseMinute("00:00")).toBe(0);
    expect(parseMinute("23:59")).toBe(1439);
  });

  it("ignores surrounding spaces", () => {
    expect(parseMinute(" 13:00 ")).toBe(780);
  });

  it("rejects out-of-range values", () => {
    expect(parseMinute("24:00")).toBeNull();
    expect(parseMinute("12:60")).toBeNull();
    expect(parseMinute("99:99")).toBeNull();
  });

  it("rejects anything that is not HH:MM", () => {
    for (const value of ["", "7", "7h30", "07:3", "07:300", "123:00", "-1:00", "07:30:00", "ab:cd", "07 30"]) {
      expect(parseMinute(value), value).toBeNull();
    }
  });

  it("round-trips with formatMinute for every minute of the day", () => {
    for (let m = 0; m < 1440; m += 7) expect(parseMinute(formatMinute(m))).toBe(m);
  });
});

describe("formatDuration", () => {
  it("uses minutes below one hour and hours above", () => {
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h 00");
    expect(formatDuration(65)).toBe("1 h 05");
    expect(formatDuration(245)).toBe("4 h 05");
  });

  it("keeps the sign and rounds", () => {
    expect(formatDuration(-30)).toBe("-30 min");
    expect(formatDuration(-90)).toBe("-1 h 30");
    expect(formatDuration(59.6)).toBe("1 h 00");
  });
});

describe("isIsoDate", () => {
  it("accepts real calendar dates", () => {
    expect(isIsoDate("2026-11-03")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-12-31")).toBe(true);
  });

  it("rejects impossible dates without throwing", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-04-31")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-00-10")).toBe(false);
    expect(isIsoDate("2026-11-32")).toBe(false);
    expect(isIsoDate("2026-11-00")).toBe(false);
  });

  it("rejects other formats and empty values", () => {
    expect(isIsoDate("2026-1-3")).toBe(false);
    expect(isIsoDate("03/11/2026")).toBe(false);
    expect(isIsoDate("2026-11-03T00:00:00Z")).toBe(false);
    expect(isIsoDate(" 2026-11-03")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});

describe("fromIsoDate / toIsoDate", () => {
  it("maps a service date to UTC midnight, the @db.Date representation", () => {
    expect(fromIsoDate("2026-11-03").toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(toIsoDate(new Date("2026-11-03T00:00:00.000Z"))).toBe("2026-11-03");
  });

  it("round-trips", () => {
    for (const day of ["2024-02-29", "2026-01-01", "2026-03-29", "2026-10-25", "2026-12-31"]) {
      expect(toIsoDate(fromIsoDate(day))).toBe(day);
    }
  });
});

describe("addDays", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("is not affected by daylight saving changes", () => {
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
  });

  it("handles zero and multi-week offsets", () => {
    expect(addDays("2026-11-02", 0)).toBe("2026-11-02");
    expect(addDays("2026-11-02", 13)).toBe("2026-11-15");
    expect(addDays("2026-11-02", -30)).toBe("2026-10-03");
    expect(addDays("2026-11-02", 365)).toBe("2027-11-02");
  });
});

describe("isoWeekday", () => {
  it("numbers days from 1 = Monday to 7 = Sunday", () => {
    expect(isoWeekday("2026-11-02")).toBe(1);
    expect(isoWeekday("2026-11-03")).toBe(2);
    expect(isoWeekday("2026-11-07")).toBe(6);
    expect(isoWeekday("2026-11-08")).toBe(7);
    expect(isoWeekday("2027-01-01")).toBe(5);
    expect(isoWeekday("2024-02-29")).toBe(4);
  });
});

describe("startOfIsoWeek", () => {
  it("returns the Monday of the week", () => {
    expect(startOfIsoWeek("2026-11-02")).toBe("2026-11-02");
    expect(startOfIsoWeek("2026-11-05")).toBe("2026-11-02");
    expect(startOfIsoWeek("2026-11-08")).toBe("2026-11-02");
    expect(startOfIsoWeek("2026-11-09")).toBe("2026-11-09");
  });

  it("crosses month and year ends", () => {
    expect(startOfIsoWeek("2026-11-01")).toBe("2026-10-26");
    expect(startOfIsoWeek("2027-01-01")).toBe("2026-12-28");
    expect(startOfIsoWeek("2027-01-03")).toBe("2026-12-28");
  });
});

describe("minuteOfDay (Europe/Paris)", () => {
  it("converts UTC instants to local minutes in winter (UTC+1) and summer (UTC+2)", () => {
    expect(minuteOfDay(new Date("2026-11-03T06:30:00Z"))).toBe(450);
    expect(minuteOfDay(new Date("2026-07-01T05:30:00Z"))).toBe(450);
  });

  it("reads local midnight as 0, not 24:00", () => {
    expect(minuteOfDay(new Date("2026-11-02T23:00:00Z"))).toBe(0);
    expect(minuteOfDay(new Date("2026-07-14T22:00:00Z"))).toBe(0);
    expect(minuteOfDay(new Date("2026-11-02T22:59:00Z"))).toBe(1439);
  });

  it("jumps from 01:59 to 03:00 when summer time starts (2026-03-29)", () => {
    expect(minuteOfDay(new Date("2026-03-29T00:59:00Z"))).toBe(119);
    expect(minuteOfDay(new Date("2026-03-29T01:00:00Z"))).toBe(180);
  });

  it("repeats 02:00 – 03:00 when summer time ends (2026-10-25)", () => {
    expect(minuteOfDay(new Date("2026-10-25T00:30:00Z"))).toBe(150);
    expect(minuteOfDay(new Date("2026-10-25T01:30:00Z"))).toBe(150);
    expect(minuteOfDay(new Date("2026-10-25T02:00:00Z"))).toBe(180);
  });
});

describe("todayIso / tomorrowIso / isoDateOf", () => {
  it("uses the calendar date in Paris, not in UTC, around midnight UTC", () => {
    // Winter: Paris is UTC+1.
    expect(todayIso(new Date("2026-11-02T22:59:59Z"))).toBe("2026-11-02");
    expect(todayIso(new Date("2026-11-02T23:00:00Z"))).toBe("2026-11-03");
    expect(todayIso(new Date("2026-11-02T23:30:00Z"))).toBe("2026-11-03");
    expect(todayIso(new Date("2026-11-03T00:30:00Z"))).toBe("2026-11-03");
    // Summer: Paris is UTC+2.
    expect(todayIso(new Date("2026-07-14T21:59:00Z"))).toBe("2026-07-14");
    expect(todayIso(new Date("2026-07-14T22:00:00Z"))).toBe("2026-07-15");
  });

  it("crosses the year end in Paris before UTC does", () => {
    expect(todayIso(new Date("2026-12-31T23:15:00Z"))).toBe("2027-01-01");
  });

  it("gives J+1 in Paris", () => {
    expect(tomorrowIso(new Date("2026-11-02T12:00:00Z"))).toBe("2026-11-03");
    expect(tomorrowIso(new Date("2026-11-02T23:30:00Z"))).toBe("2026-11-04");
  });

  it("isoDateOf matches todayIso", () => {
    const instant = new Date("2026-10-25T22:30:00Z");
    expect(isoDateOf(instant)).toBe("2026-10-25");
    expect(isoDateOf(new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
  });

  it("always returns a valid YYYY-MM-DD", () => {
    expect(isIsoDate(todayIso())).toBe(true);
  });
});

describe("date labels", () => {
  it("formats long and short French dates", () => {
    expect(formatLongDate("2026-11-03")).toBe("mardi 3 novembre 2026");
    expect(formatShortDate("2026-11-03")).toBe("03/11/2026");
  });

  it("labels ISO weekdays", () => {
    expect(WEEKDAY_LABELS[1]).toBe("Lundi");
    expect(WEEKDAY_LABELS[7]).toBe("Dimanche");
    expect(WEEKDAY_SHORT[isoWeekday("2026-11-07")]).toBe("Sam");
  });
});

describe("formatDateTime, formatTimeOn and formatDayDate: the one way to write an instant or a day", () => {
  const NOW = new Date("2026-11-10T12:00:00Z");

  it("writes « 02/11 à 18:40 » in Europe/Paris, with the year only outside the current one", () => {
    expect(formatDateTime(new Date("2026-11-03T07:12:00Z"), NOW)).toBe("03/11 à 08:12");
    expect(formatDateTime("2026-07-14T21:30:00Z", NOW)).toBe("14/07 à 23:30"); // summer time
    expect(formatDateTime(new Date("2026-11-03T23:05:00Z"), NOW)).toBe("04/11 à 00:05"); // next day in Paris, 00 not 24
    expect(formatDateTime(new Date("2025-12-31T22:30:00Z"), NOW)).toBe("31/12/2025 à 23:30");
  });

  it("gives the time alone on the day shown, and the day too otherwise", () => {
    expect(formatTimeOn("2026-11-03T07:02:00.000Z", "2026-11-03", NOW)).toBe("08:02");
    // 23:30 UTC on the 2nd is 00:30 on the 3rd in Paris.
    expect(formatTimeOn("2026-11-02T23:30:00.000Z", "2026-11-03", NOW)).toBe("00:30");
    expect(formatTimeOn("2026-11-03T23:10:00.000Z", "2026-11-03", NOW)).toBe("04/11 à 00:10");
  });

  it("writes a day as « 12/11 », with the year outside the current one", () => {
    expect(formatDayDate("2026-11-12", NOW)).toBe("12/11");
    expect(formatDayDate("2027-01-04", NOW)).toBe("04/01/2027");
  });
});
