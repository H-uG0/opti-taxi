import { describe, expect, it } from "vitest";
import { computeKpisByDay, summarizePeriod } from "@/lib/kpis";
import { periodSummaryLines } from "./kpis";
import { dayTableHeader, emptyDayReport, formatDayLine, interruptedMessage, totalReport, type DayReport } from "./report";

const day: DayReport = {
  ...emptyDayReport("2026-10-12", null),
  trips: 61,
  realized: 54,
  handedOver: 2,
  cancelled: 2,
  noShows: 1,
  shared: 18,
  refused: 4,
  accepted: 15,
  runs: 2,
  planningMinutes: 34.4,
  late: 1,
  refreshed: 1,
};

describe("day report", () => {
  it("prints one aligned line per day", () => {
    const line = formatDayLine(day);
    expect(line.startsWith("Lun 12/10/2026")).toBe(true);
    expect(line).toContain("34 min");
    expect(line.length).toBe(dayTableHeader().length);
  });

  it("shows the trips handed over to a partner company in their own column", () => {
    expect(dayTableHeader()).toContain("confiées");
    expect(dayTableHeader()).not.toContain("non aff.");
  });

  it("flags what went wrong at the end of the day's line", () => {
    const line = formatDayLine({ ...day, unassigned: 1, notRefreshed: 2 });
    expect(line.startsWith(formatDayLine(day))).toBe(true);
    expect(line).toContain("1 course restée sans tournée");
    expect(line).toContain("2 tournées non recalculées après annulation");
  });

  it("says why a day was skipped", () => {
    expect(formatDayLine(emptyDayReport("2026-10-13", "données existantes"))).toBe("Mar 13/10/2026 ignoré : données existantes");
  });

  it("sums simulated days only", () => {
    const total = totalReport([day, day, emptyDayReport("2026-10-13", "ignoré")]);
    expect(total.trips).toBe(122);
    expect(total.runs).toBe(4);
    expect(total.refused).toBe(8);
    expect(total.handedOver).toBe(4);
    expect(total.notRefreshed).toBe(0);
  });
});

describe("interruptedMessage", () => {
  it("says which day was removed and what state the period is left in", () => {
    const message = interruptedMessage("2026-10-14", "Le service d'optimisation ne répond pas.", 3, true);
    expect(message.split("\n")[0]).toBe("Le service d'optimisation ne répond pas.");
    expect(message).toContain("Simulation interrompue le 14/10/2026 : ce jour a été retiré de la base.");
    expect(message).toContain("Les 3 jours précédents sont simulés");
    expect(message).toContain("les jours suivants gardent la simulation précédente");
    expect(message).toContain("Relancez pnpm db:history");
  });

  it("handles the first day and a day that could not be removed", () => {
    expect(interruptedMessage("2026-10-09", "x", 0, false)).toContain("Aucun jour n'a été simulé");
    expect(interruptedMessage("2026-10-09", "x", 0, false)).toContain("n'a pas pu être retiré");
    expect(interruptedMessage("2026-10-10", "x", 1, true)).toContain("Le jour précédent est simulé");
  });
});

describe("periodSummaryLines", () => {
  it("prints the dashboard indicators in French, with a dash when unknown", () => {
    const empty = summarizePeriod(computeKpisByDay("2026-10-12", "2026-10-13", { routes: [], trips: [], runs: [] }, "2026-11-02"));
    const lines = periodSummaryLines(empty);
    expect(lines[0]).toContain("du 12/10/2026 au 13/10/2026");
    expect(lines.find((l) => l.startsWith("Part des km à vide"))).toContain("—");
    expect(lines.find((l) => l.startsWith("Temps de planification moyen"))).toContain("—");
  });

  it("formats rates as percentages", () => {
    const data = {
      routes: [
        {
          serviceDate: "2026-10-12",
          vehicleId: "v1",
          distanceKm: 200,
          emptyKm: 50,
          revenue: 900,
          cost: 400,
          margin: 500,
          validatedAt: new Date("2026-10-11T15:40:00Z"),
          stopCount: 4,
          hasRecordedStatus: true,
        },
      ],
      trips: [],
      runs: [{ serviceDate: "2026-10-12", startedAt: new Date("2026-10-11T15:00:00Z") }],
    };
    const lines = periodSummaryLines(summarizePeriod(computeKpisByDay("2026-10-12", "2026-10-12", data, "2026-11-02")));
    expect(lines.find((l) => l.startsWith("Part des km à vide"))).toMatch(/25,0\s?%/);
    expect(lines.find((l) => l.startsWith("Temps de planification moyen"))).toContain("40 min (1 optimisation)");
    expect(lines[0]).toContain("(1 jour planifié, 1 validé)");
  });
});
