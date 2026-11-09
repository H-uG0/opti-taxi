import { describe, expect, it } from "vitest";
import { easterSunday, frenchPublicHolidays } from "./holidays";

describe("public holidays", () => {
  it.each([
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2038, "2038-04-25"],
  ])("Easter %i is %s", (year, date) => {
    expect(easterSunday(year)).toBe(date);
  });

  it("lists the 11 legal holidays of 2026 with the movable ones", () => {
    const days = frenchPublicHolidays(2026);
    expect(days).toHaveLength(11);
    expect(days.map((d) => d.date)).toEqual([
      "2026-01-01",
      "2026-04-06",
      "2026-05-01",
      "2026-05-08",
      "2026-05-14",
      "2026-05-25",
      "2026-07-14",
      "2026-08-15",
      "2026-11-01",
      "2026-11-11",
      "2026-12-25",
    ]);
    expect(days.find((d) => d.date === "2026-05-14")?.label).toBe("Ascension");
  });
});
