import { describe, expect, it } from "vitest";
import { barWidthFor, chartGeometry, describeSeries } from "./chart-geometry";

const fmt = (v: number) => v.toFixed(1);
const date = (d: string) => d.slice(5);

describe("chartGeometry", () => {
  it("places bars in equal slots and scales them from the zero baseline", () => {
    const g = chartGeometry(
      [
        { date: "2026-11-01", value: 2 },
        { date: "2026-11-02", value: 4 },
      ],
      64,
    );
    expect(g.shapes.map((s) => s.centerPct)).toEqual([25, 75]);
    expect(g.shapes.map((s) => s.slotPct)).toEqual([0, 50]);
    const [small, tall] = g.shapes;
    expect(tall?.bar?.y).toBe(6); // top padding: the maximum touches the top of the plot
    expect(tall?.bar && tall.bar.y + tall.bar.height).toBe(g.zeroY);
    expect(small?.bar?.height).toBeCloseTo((tall?.bar?.height ?? 0) / 2);
  });

  it("draws nothing for unknown values and a visible stub for zero", () => {
    const g = chartGeometry([
      { date: "a", value: null },
      { date: "b", value: 0 },
      { date: "c", value: 5 },
    ]);
    expect(g.shapes[0]?.bar).toBeNull();
    expect(g.shapes[1]?.bar?.height).toBe(1.5);
  });

  it("handles negative values (a loss) below the baseline", () => {
    const g = chartGeometry([
      { date: "a", value: 100 },
      { date: "b", value: -100 },
    ]);
    const loss = g.shapes[1]?.bar;
    expect(loss?.negative).toBe(true);
    expect(loss?.y).toBe(g.zeroY);
    expect(g.zeroY).toBeCloseTo(6 + (64 - 8) / 2);
  });

  it("includes the secondary series in the scale", () => {
    const g = chartGeometry([{ date: "a", value: 2, secondary: 4 }]);
    expect(g.shapes[0]?.dotY).toBe(6);
    expect(chartGeometry([{ date: "a", value: 2, secondary: null }]).shapes[0]?.dotY).toBeNull();
  });

  it("survives an empty or all-null series", () => {
    expect(chartGeometry([]).shapes).toEqual([]);
    const g = chartGeometry([{ date: "a", value: null }], 64);
    expect(g.zeroY).toBe(62); // baseline at the bottom of the plot
    const zeros = chartGeometry([{ date: "a", value: 0 }], 64);
    expect(zeros.zeroY).toBe(62);
  });

  it("thins bars as the range grows", () => {
    expect(barWidthFor(7)).toBe(14);
    expect(barWidthFor(14)).toBe(10);
    expect(barWidthFor(31)).toBe(6);
    expect(barWidthFor(92)).toBe(3);
  });
});

describe("describeSeries", () => {
  it("summarizes min, max and last known value", () => {
    const text = describeSeries(
      "Courses",
      [
        { date: "2026-11-01", value: 3 },
        { date: "2026-11-02", value: 5 },
        { date: "2026-11-03", value: 4 },
        { date: "2026-11-04", value: null },
      ],
      fmt,
      date,
    );
    expect(text).toBe(
      "Courses, du 11-01 au 11-04 : 3 jours renseignés ; minimum 3.0 le 11-01, maximum 5.0 le 11-02, dernière valeur 4.0 le 11-03.",
    );
  });

  it("says when there is no data", () => {
    expect(describeSeries("Courses", [], fmt, date)).toBe("Courses : aucune donnée.");
    expect(describeSeries("Courses", [{ date: "2026-11-01", value: null }], fmt, date)).toBe(
      "Courses, du 11-01 au 11-01 : aucune donnée.",
    );
  });
});
