import { describe, expect, it } from "vitest";
import { NOTHING_REFRESHED } from "@/lib/planning/refresh-routes";
import { createdTripsHref, readTripNotice, updatedSentence, updatedTripHref } from "./trip-notices";

const params = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);

describe("trip notices of « Courses »", () => {
  it("round-trips a creation of one trip or of both legs", () => {
    expect(readTripNotice(params(createdTripsHref("2026-11-16", ["a"])))).toEqual({ kind: "created", tripIds: ["a"] });
    expect(readTripNotice(params(createdTripsHref("2026-11-16", ["a", "b"])))).toEqual({ kind: "created", tripIds: ["a", "b"] });
  });

  it("round-trips an edit: the changes, whether the trip left its route and the routes recomputed", () => {
    const href = updatedTripHref("2026-11-17", "t1", {
      changes: ["date", "home"],
      detached: true,
      refresh: { ...NOTHING_REFRESHED, refreshed: 1 },
    });
    expect(href).toBe("/courses?date=2026-11-17&notice=updated&course=t1&modif=date%2Chome&retiree=1&tournees=1-0-0-0");
    expect(readTripNotice(params(href))).toEqual({
      kind: "updated",
      tripId: "t1",
      changes: ["date", "home"],
      detached: true,
      refresh: { ...NOTHING_REFRESHED, refreshed: 1 },
    });
  });

  it("ignores codes it does not know, and a notice without its trip", () => {
    expect(readTripNotice({ notice: "updated", course: "t1", modif: "date,<script>" })).toMatchObject({ changes: ["date"] });
    expect(readTripNotice({ notice: "updated" })).toBeNull();
    expect(readTripNotice({})).toBeNull();
  });

  it("says what changed", () => {
    expect(updatedSentence(["home", "notes"])).toBe("Course modifiée (adresse du patient et notes).");
    expect(updatedSentence([])).toBe("Course modifiée.");
  });
});
