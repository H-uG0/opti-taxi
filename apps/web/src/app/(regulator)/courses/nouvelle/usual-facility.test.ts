import { describe, expect, it } from "vitest";
import { suggestedReturnMinute, usualFacility } from "./usual-facility";

const ACTIVE = new Set(["dialysis", "radio", "clinic"]);
const at = (iso: string) => new Date(`${iso}T08:00:00Z`);

describe("usualFacility", () => {
  it("proposes the facility of the recurrence with the most days, the latest on a tie", () => {
    const recurrences = [
      { facilityId: "radio", weekdays: [2], sessionMinutes: 30, createdAt: at("2026-10-01") },
      { facilityId: "dialysis", weekdays: [1, 3, 5], sessionMinutes: 240, createdAt: at("2026-09-01") },
    ];
    expect(usualFacility(recurrences, [], ACTIVE)).toEqual({ facilityId: "dialysis", sessionMinutes: 240 });
    const tie = [
      { facilityId: "radio", weekdays: [1, 2], sessionMinutes: 30, createdAt: at("2026-10-01") },
      { facilityId: "dialysis", weekdays: [3, 5], sessionMinutes: 240, createdAt: at("2026-09-01") },
    ];
    expect(usualFacility(tie, [], ACTIVE)?.facilityId).toBe("radio");
  });

  it("falls back on the latest trip's facility, never a deactivated one", () => {
    const trips = [
      { facilityId: "clinic", serviceDate: "2026-10-02" },
      { facilityId: null, serviceDate: "2026-11-01" },
      { facilityId: "closed", serviceDate: "2026-11-05" },
    ];
    expect(usualFacility([], trips, ACTIVE)).toEqual({ facilityId: "clinic", sessionMinutes: null });
    const closedOnly = [{ facilityId: "closed", weekdays: [1, 3, 5], sessionMinutes: 240, createdAt: at("2026-09-01") }];
    expect(usualFacility(closedOnly, [], ACTIVE)).toBeNull();
  });
});

describe("suggestedReturnMinute", () => {
  it("adds the usual session to the appointment, before midnight only", () => {
    expect(suggestedReturnMinute(450, 240)).toBe(690);
    expect(suggestedReturnMinute(450, null)).toBeNull();
    expect(suggestedReturnMinute(null, 240)).toBeNull();
    expect(suggestedReturnMinute(1320, 180)).toBeNull();
  });
});
