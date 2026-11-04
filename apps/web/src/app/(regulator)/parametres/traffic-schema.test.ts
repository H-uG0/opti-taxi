import { describe, expect, it } from "vitest";
import { errorState, IDLE_STATE, messageState, successState } from "@/lib/forms";
import { factorField, radiusField, toTrafficUpdate, trafficChanged, trafficFormValues, trafficFormView, trafficSchema } from "./traffic-schema";

const MARSEILLE = { id: "mrs", radiusKm: 14, morningFactor: 1.5, dayFactor: 1.2, eveningFactor: 1.5 };
const ROAD = { id: "road", radiusKm: null, morningFactor: 1.05, dayFactor: 1, eveningFactor: 1.05 };
const ZONES = [MARSEILLE, ROAD];
const SETTINGS = {
  trafficEnabled: true,
  morningPeakStartMinute: 420,
  morningPeakEndMinute: 570,
  eveningPeakStartMinute: 960,
  eveningPeakEndMinute: 1140,
};

function form(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...(trafficFormValues(SETTINGS, ZONES) as Record<string, string>),
    ...overrides,
  };
}

function errorsOf(values: Record<string, string>): Record<string, string | undefined> {
  const result = trafficSchema(ZONES).safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
}

describe("trafficSchema", () => {
  it("accepts the stored values and gives them back unchanged", () => {
    const parsed = trafficSchema(ZONES).parse(form());
    const update = toTrafficUpdate(parsed, ZONES);
    expect(update.settings).toEqual(SETTINGS);
    expect(update.zones).toEqual(ZONES);
    expect(trafficChanged(SETTINGS, ZONES, update)).toBe(false);
  });

  it("reads French decimals and a switched-off box", () => {
    const off = form({ [factorField("mrs", "morning")]: "1,75" });
    delete off.trafficEnabled;
    const update = toTrafficUpdate(trafficSchema(ZONES).parse(off), ZONES);
    expect(update.settings.trafficEnabled).toBe(false);
    expect(update.zones[0]?.morningFactor).toBe(1.75);
    expect(trafficChanged(SETTINGS, ZONES, update)).toBe(true);
  });

  it("refuses a factor under 1 or above the maximum, and a radius out of range", () => {
    expect(errorsOf(form({ [factorField("mrs", "day")]: "0,9" }))[factorField("mrs", "day")]).toMatch(/Minimum/);
    expect(errorsOf(form({ [factorField("road", "day")]: "3,5" }))[factorField("road", "day")]).toMatch(/Maximum/);
    expect(errorsOf(form({ [radiusField("mrs")]: "60" }))[radiusField("mrs")]).toMatch(/Maximum/);
  });

  it("has no radius for the road row", () => {
    const parsed = trafficSchema(ZONES).parse(form());
    expect(toTrafficUpdate(parsed, ZONES).zones[1]?.radiusKm).toBeNull();
    expect(trafficFormValues(SETTINGS, ZONES)[radiusField("road")]).toBeUndefined();
  });

  it("wants the peaks in order, with a day between them", () => {
    expect(errorsOf(form({ morningPeakEnd: "07:00" })).morningPeakEnd).toMatch(/après son début/);
    expect(errorsOf(form({ eveningPeakStart: "09:30" })).eveningPeakStart).toMatch(/après celle du matin \(09:30\)/);
    expect(errorsOf(form({ eveningPeakEnd: "15:00" })).eveningPeakEnd).toMatch(/après son début/);
  });
});

describe("trafficFormView", () => {
  const stored = { morningPeakStart: "07:00" };
  const typed = { morningPeakStart: "nope" };
  const invalid = { ...errorState({ morningPeakStart: "Heure attendue" }, typed), submissionId: 1 };

  it("shows the stored values before any response", () => {
    expect(trafficFormView(IDLE_STATE, IDLE_STATE, stored)).toEqual({ response: IDLE_STATE, values: stored, errors: {} });
  });

  it("keeps what was typed after an invalid save", () => {
    const view = trafficFormView(invalid, IDLE_STATE, stored);
    expect(view).toEqual({ response: invalid, values: typed, errors: invalid.fieldErrors });
  });

  it("drops what was typed once observed values are applied", () => {
    const applied = { ...successState("Valeurs observées appliquées"), submissionId: 2 };
    expect(trafficFormView(invalid, applied, stored)).toEqual({ response: applied, values: stored, errors: {} });
  });

  it("keeps what was typed when applying fails", () => {
    const refused = { ...messageState("Pas encore assez de trajets"), submissionId: 2 };
    expect(trafficFormView(invalid, refused, stored)).toEqual({ response: refused, values: typed, errors: invalid.fieldErrors });
  });

  it("speaks of the save when it comes after applying", () => {
    const applied = { ...successState("Valeurs observées appliquées"), submissionId: 1 };
    const saved = { ...successState("Trafic enregistré"), submissionId: 2 };
    expect(trafficFormView(saved, applied, stored).response).toBe(saved);
  });
});
