import { describe, expect, it } from "vitest";
import { correctionTargets, currentTarget, decideCorrection, type CorrectionInput } from "./stop-correction";

const NOW = new Date("2026-11-03T18:00:00.000Z");
const at = (hhmm: string) => new Date(`2026-11-03T${hhmm}:00.000Z`);
const input = (overrides: Partial<CorrectionInput>): CorrectionInput => ({
  kind: "PICKUP",
  tripStatus: "ASSIGNED",
  completedAt: null,
  otherAt: null,
  target: "PICKUP",
  at: at("08:10"),
  now: NOW,
  ...overrides,
});

describe("decideCorrection (FLD-02)", () => {
  it("records a forgotten pickup or drop-off, the trip following", () => {
    expect(decideCorrection(input({}))).toEqual({ ok: true, completedAt: at("08:10"), tripStatus: "PICKED_UP" });
    expect(decideCorrection(input({ kind: "DROPOFF", tripStatus: "PICKED_UP", target: "DROPOFF", otherAt: at("08:10"), at: at("08:40") }))).toEqual({
      ok: true,
      completedAt: at("08:40"),
      tripStatus: "DROPPED_OFF",
    });
    // The pickup's time fixed on a trip already dropped off: it stays dropped off.
    expect(decideCorrection(input({ tripStatus: "DROPPED_OFF", completedAt: at("08:20"), otherAt: at("08:40"), at: at("08:12") }))).toMatchObject({
      ok: true,
      tripStatus: "DROPPED_OFF",
    });
  });

  it("turns a pickup into an absence, or removes a status, while its drop-off is not recorded", () => {
    expect(decideCorrection(input({ tripStatus: "PICKED_UP", completedAt: at("08:10"), target: "NO_SHOW", at: at("08:15") }))).toEqual({
      ok: true,
      completedAt: at("08:15"),
      tripStatus: "NO_SHOW",
    });
    expect(decideCorrection(input({ tripStatus: "NO_SHOW", completedAt: at("08:10"), target: "NONE", at: null }))).toEqual({ ok: true, completedAt: null, tripStatus: "ASSIGNED" });
    expect(decideCorrection(input({ tripStatus: "DROPPED_OFF", completedAt: at("08:10"), target: "NO_SHOW" }))).toMatchObject({ ok: false, error: expect.stringContaining("retirez-la d'abord") });
    expect(decideCorrection(input({ kind: "DROPOFF", tripStatus: "DROPPED_OFF", completedAt: at("08:40"), target: "NONE", at: null }))).toEqual({
      ok: true,
      completedAt: null,
      tripStatus: "PICKED_UP",
    });
  });

  it("refuses a cancelled trip, a time to come, a drop-off before its pickup or without it, and no change", () => {
    expect(decideCorrection(input({ tripStatus: "CANCELLED" }))).toMatchObject({ ok: false });
    expect(decideCorrection(input({ at: at("19:00") }))).toMatchObject({ ok: false, error: expect.stringContaining("Heure à venir") });
    expect(decideCorrection(input({ at: null }))).toMatchObject({ ok: false, error: "Indiquez l'heure réelle." });
    expect(decideCorrection(input({ kind: "DROPOFF", target: "DROPOFF", tripStatus: "ASSIGNED" }))).toMatchObject({ ok: false, error: expect.stringContaining("Prise en charge non enregistrée") });
    expect(decideCorrection(input({ kind: "DROPOFF", target: "DROPOFF", tripStatus: "PICKED_UP", otherAt: at("08:30"), at: at("08:20") }))).toMatchObject({ ok: false });
    expect(decideCorrection(input({ target: "PICKUP", otherAt: at("08:00"), tripStatus: "DROPPED_OFF", completedAt: at("07:50") }))).toMatchObject({ ok: false });
    expect(decideCorrection(input({ tripStatus: "PICKED_UP", completedAt: at("08:10") }))).toMatchObject({ ok: false, error: expect.stringContaining("Aucun changement") });
    expect(decideCorrection(input({ target: "NONE", at: null }))).toMatchObject({ ok: false, error: "Aucun statut à retirer." });
    expect(decideCorrection(input({ kind: "DROPOFF", target: "NO_SHOW" }))).toMatchObject({ ok: false });
  });

  it("names what a stop shows now and what it can become", () => {
    expect(correctionTargets("PICKUP")).toEqual(["PICKUP", "NO_SHOW", "NONE"]);
    expect(correctionTargets("DROPOFF")).toEqual(["DROPOFF", "NONE"]);
    expect(currentTarget("PICKUP", null, "ASSIGNED")).toBe("NONE");
    expect(currentTarget("PICKUP", null, "PICKED_UP")).toBe("PICKUP");
    expect(currentTarget("PICKUP", at("08:00"), "NO_SHOW")).toBe("NO_SHOW");
    expect(currentTarget("DROPOFF", at("08:00"), "DROPPED_OFF")).toBe("DROPOFF");
    expect(currentTarget("DROPOFF", null, "NO_SHOW")).toBe("NONE");
  });
});
