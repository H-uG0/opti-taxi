import { describe, expect, it } from "vitest";
import { coversWholeDay, freeHoursOfAll, freeHoursOn, takenHoursText } from "./partial-day";

const day = "2026-11-14";

describe("partial-day unavailability (DAY-03)", () => {
  it("takes the whole day only without a time on that day", () => {
    expect(coversWholeDay({ startDate: day, endDate: day }, day)).toBe(true);
    expect(coversWholeDay({ startDate: day, endDate: day, startMinute: 680 }, day)).toBe(false);
    // Out from 11:20 on the 13th: the whole of the 14th.
    expect(coversWholeDay({ startDate: "2026-11-13", endDate: "2026-11-15", startMinute: 680 }, day)).toBe(true);
    expect(coversWholeDay({ startDate: "2026-11-13", endDate: day, endMinute: 600 }, day)).toBe(false);
    expect(coversWholeDay({ startDate: "2026-11-15", endDate: "2026-11-16" }, day)).toBe(false);
  });

  it("says the hours left free that day", () => {
    expect(freeHoursOn({ startDate: day, endDate: day, startMinute: 680 }, day)).toEqual({ from: null, until: 680 });
    expect(freeHoursOn({ startDate: "2026-11-13", endDate: day, endMinute: 600 }, day)).toEqual({ from: 600, until: null });
    expect(freeHoursOn({ startDate: day, endDate: day }, day)).toBeNull();
    expect(
      freeHoursOfAll(
        [
          { startDate: day, endDate: day, startMinute: 900 },
          { startDate: day, endDate: day, startMinute: 680 },
          { startDate: "2026-11-12", endDate: day, endMinute: 450 },
        ],
        day,
      ),
    ).toEqual({ from: 450, until: 680 });
    expect(takenHoursText({ startDate: day, endDate: day, startMinute: 680 }, day)).toBe("à partir de 11:20");
    expect(takenHoursText({ startDate: "2026-11-12", endDate: day, endMinute: 600 }, day)).toBe("jusqu'à 10:00");
  });
});
