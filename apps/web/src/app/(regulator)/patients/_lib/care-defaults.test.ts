import { describe, expect, it } from "vitest";
import { defaultMode, defaultSharing, validityEnd, withCareDefaults } from "./care-defaults";

const EMPTY = { label: "", weekdays: [], sessionMinutes: "" };

describe("withCareDefaults", () => {
  it("proposes dialysis on Monday, Wednesday and Friday for 4 h, radiotherapy every weekday", () => {
    expect(withCareDefaults(EMPTY, "DIALYSIS")).toEqual({ label: "Dialyse", weekdays: ["1", "3", "5"], sessionMinutes: "240" });
    expect(withCareDefaults(EMPTY, "RADIOTHERAPY")).toEqual({
      label: "Radiothérapie",
      weekdays: ["1", "2", "3", "4", "5"],
      sessionMinutes: "30",
    });
    expect(withCareDefaults(EMPTY, "CHEMOTHERAPY")).toEqual({ label: "Chimiothérapie", weekdays: [], sessionMinutes: "" });
    expect(withCareDefaults(EMPTY, "HOSPITAL")).toEqual(EMPTY);
    expect(withCareDefaults(EMPTY, null)).toEqual(EMPTY);
  });

  it("never overwrites what the regulator filled", () => {
    const typed = { label: "Dialyse de repli", weekdays: ["2", "4", "6"], sessionMinutes: "210" };
    expect(withCareDefaults(typed, "DIALYSIS")).toEqual(typed);
    expect(withCareDefaults({ ...EMPTY, weekdays: ["2", "4", "6"] }, "DIALYSIS")).toEqual({
      label: "Dialyse",
      weekdays: ["2", "4", "6"],
      sessionMinutes: "240",
    });
  });

  it("follows another facility type while the values are still the previous defaults", () => {
    const dialysis = withCareDefaults(EMPTY, "DIALYSIS");
    expect(withCareDefaults(dialysis, "RADIOTHERAPY", "DIALYSIS")).toEqual({
      label: "Radiothérapie",
      weekdays: ["1", "2", "3", "4", "5"],
      sessionMinutes: "30",
    });
    expect(withCareDefaults(dialysis, "CLINIC", "DIALYSIS")).toEqual(EMPTY);
    expect(withCareDefaults({ ...dialysis, sessionMinutes: "200" }, "RADIOTHERAPY", "DIALYSIS").sessionMinutes).toBe("200");
  });
});

describe("prescription defaults", () => {
  it("prescribes an ambulance for a lying patient, never shared", () => {
    expect(defaultMode("LYING")).toBe("AMBULANCE");
    expect(defaultMode("WHEELCHAIR")).toBe("TAP");
    expect(defaultSharing("AMBULANCE")).toBe("NONE");
    expect(defaultSharing("TAP")).toBe("BOTH");
  });

  it("ends a validity the day before the same date N months later", () => {
    expect(validityEnd("2026-11-14", 3)).toBe("2027-02-13");
    expect(validityEnd("2026-11-14", 12)).toBe("2027-11-13");
    expect(validityEnd("2026-11-30", 3)).toBe("2027-02-27");
    expect(validityEnd("2027-01-31", 1)).toBe("2027-02-27");
  });
});
