import { describe, expect, it } from "vitest";
import { checkReading, dailyPace, daysUntilKm, latestKm, MAX_DAILY_KM, paceText, realAgainstPlanned } from "./odometer";

describe("odometer readings (FLD-03)", () => {
  const others = [
    { date: "2026-11-10", km: 120_000, moment: "FILL" as const },
    { date: "2026-11-13", km: 120_400, moment: "END" as const },
  ];

  it("takes a reading at or above the last mileage known", () => {
    expect(checkReading({ km: 120_400, date: "2026-11-14", moment: "START", others, startKm: null })).toEqual({ ok: true });
    expect(checkReading({ km: 120_650, date: "2026-11-14", moment: "END", others, startKm: 120_420 })).toEqual({ ok: true });
  });

  it("never takes a decrease: below the last reading, below the day's start, above a later one", () => {
    expect(checkReading({ km: 120_399, date: "2026-11-14", moment: "START", others, startKm: null })).toEqual({
      ok: false,
      kind: "refused",
      message: "Inférieur au dernier relevé connu (120 400 km le 13/11/2026) : vérifiez le compteur.",
    });
    expect(checkReading({ km: 120_410, date: "2026-11-14", moment: "END", others, startKm: 120_420 })).toMatchObject({ ok: false, kind: "refused" });
    expect(checkReading({ km: 120_500, date: "2026-11-12", moment: "END", others, startKm: null })).toMatchObject({
      ok: false,
      kind: "refused",
      message: expect.stringContaining("plus récent"),
    });
  });

  it("asks to confirm an unusual jump: more than 1 000 km a day since the last reading, or over the day", () => {
    expect(checkReading({ km: 123_000, date: "2026-11-14", moment: "START", others, startKm: null })).toEqual({
      ok: false,
      kind: "confirm",
      message: "+2 600 km depuis le relevé du 13/11/2026 : saut inhabituel. Vérifiez, puis confirmez.",
    });
    // Ten days without a reading: 2 600 km is plausible.
    expect(checkReading({ km: 123_000, date: "2026-11-23", moment: "START", others, startKm: null })).toEqual({ ok: true });
    expect(checkReading({ km: 120_420 + MAX_DAILY_KM + 1, date: "2026-11-14", moment: "END", others, startKm: 120_420 })).toMatchObject({
      kind: "confirm",
      message: expect.stringContaining("depuis le départ"),
    });
  });

  it("knows the last mileage, the real km against the planned ones, the pace and the days left", () => {
    expect(latestKm(others)).toEqual(others[1]);
    expect(latestKm([])).toBeNull();
    expect(
      realAgainstPlanned([
        { date: "2026-11-13", startKm: 100, endKm: 300, plannedKm: 180 },
        { date: "2026-11-14", startKm: 300, endKm: 420, plannedKm: null },
        { date: "2026-11-15", startKm: 420, endKm: 540, plannedKm: 110 },
      ]),
    ).toEqual({ days: 2, realKm: 320, plannedKm: 290 });
    // 2 100 km in 21 days: 100 km a day.
    const points = [
      { date: "2026-10-25", km: 118_000 },
      { date: "2026-11-15", km: 120_100 },
    ];
    expect(dailyPace(points, "2026-11-15")).toBe(100);
    // A single day does not set the pace (at least 7 days).
    expect(dailyPace([{ date: "2026-11-14", km: 1000 }, { date: "2026-11-15", km: 1210 }], "2026-11-15")).toBe(30);
    expect(dailyPace([{ date: "2026-11-15", km: 1000 }], "2026-11-15")).toBeNull();
    expect(daysUntilKm(121_000, 120_100, 100)).toBe(9);
    expect(daysUntilKm(121_000, 121_200, 100)).toBe(0);
    expect(daysUntilKm(121_000, 120_100, null)).toBeNull();
    expect(paceText(9)).toBe("environ 9 jours au rythme actuel");
    expect(paceText(1)).toBe("moins d'un jour au rythme actuel");
    expect(paceText(null)).toBeNull();
  });
});
