import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { toUpcomingRoutes, upcomingRouteDates, upcomingRoutesNotice, type UpcomingRoute } from "./upcoming-routes";

const proposed = (date: string): UpcomingRoute => ({ date, status: "PROPOSED" });
const validated = (date: string): UpcomingRoute => ({ date, status: "VALIDATED" });

describe("toUpcomingRoutes", () => {
  it("converts @db.Date values and sorts by date", () => {
    expect(
      toUpcomingRoutes([
        { serviceDate: fromIsoDate("2026-11-04"), status: "VALIDATED" },
        { serviceDate: fromIsoDate("2026-11-03"), status: "PROPOSED" },
      ]),
    ).toEqual([proposed("2026-11-03"), validated("2026-11-04")]);
  });
});

describe("upcomingRouteDates", () => {
  it("returns distinct dates in order", () => {
    expect(upcomingRouteDates([proposed("2026-11-04"), proposed("2026-11-03"), validated("2026-11-04")])).toEqual([
      "2026-11-03",
      "2026-11-04",
    ]);
  });
});

describe("upcomingRoutesNotice", () => {
  it("is null without upcoming route", () => {
    expect(upcomingRoutesNotice([], "vehicle")).toBeNull();
    expect(upcomingRoutesNotice([], "driver")).toBeNull();
  });

  it("describes a single proposed route on a vehicle", () => {
    expect(upcomingRoutesNotice([proposed("2026-11-03")], "vehicle")).toBe(
      "1 tournée à venir (03/11/2026) utilise ce véhicule. La désactivation ne la modifie pas : relancez l'optimisation de ce jour depuis le planning.",
    );
  });

  it("counts validated routes and agrees in number for a driver", () => {
    expect(upcomingRoutesNotice([proposed("2026-11-03"), validated("2026-11-04")], "driver")).toBe(
      "2 tournées à venir (03/11/2026, 04/11/2026), dont 1 validée, lui sont attribuées. La désactivation ne les modifie pas : relancez l'optimisation de ces jours depuis le planning.",
    );
  });

  it("says when every route is validated", () => {
    expect(upcomingRoutesNotice([validated("2026-11-03")], "driver")).toMatch(
      /^1 tournée validée à venir \(03\/11\/2026\) lui est attribuée\./,
    );
    expect(upcomingRoutesNotice([validated("2026-11-03"), validated("2026-11-05")], "vehicle")).toMatch(
      /^2 tournées validées à venir \(03\/11\/2026, 05\/11\/2026\) utilisent ce véhicule\./,
    );
  });

  it("speaks of a single day when the routes share a date", () => {
    // A person can be driver of one route and crew mate of another the same day.
    expect(upcomingRoutesNotice([proposed("2026-11-03"), proposed("2026-11-03")], "driver")).toMatch(
      /^2 tournées à venir \(03\/11\/2026\) lui sont attribuées\. .*de ce jour depuis le planning\.$/,
    );
  });

  it("shortens a long list of dates", () => {
    const routes = ["03", "04", "05", "06", "07", "08", "09"].map((day) => proposed(`2026-11-${day}`));
    expect(upcomingRoutesNotice(routes, "vehicle")).toMatch(
      /^7 tournées à venir \(03\/11\/2026, 04\/11\/2026, 05\/11\/2026, 06\/11\/2026, 07\/11\/2026…\) utilisent/,
    );
  });
});
