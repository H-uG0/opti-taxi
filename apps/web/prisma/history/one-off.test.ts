import { describe, expect, it } from "vitest";
import { OCCASIONAL_POOL_SIZE, ONE_OFF_EPISODES_PER_WEEKDAY, type AnyFacilityKey } from "../seed/data";
import { episodesPerWeekday, isOccasionalPatient, planOneOffDay, type DestinationRow, type PoolPatientRow } from "./one-off";

const pool: PoolPatientRow[] = Array.from({ length: 120 }, (_, i) => ({
  id: `occasional-${String(i + 1).padStart(4, "0")}`,
  mobility: i % 6 === 0 ? "LYING" : "SEATED",
  address: `${i + 1} rue des Lilas`,
  postalCode: "05000",
  city: i % 2 === 0 ? "Gap" : "Sisteron",
  lat: 44.5,
  lng: 6,
}));
const keys: AnyFacilityKey[] = ["hospitalGap", "hospitalGrenoble", "hospitalMarseille", "hospitalManosque", "imagingGap", "imagingSisteron"];
const facilities = new Map<AnyFacilityKey, DestinationRow>(keys.map((key) => [key, { id: `fac-${key}`, address: key, lat: 44.6, lng: 6.1 }]));

describe("one-off care of a simulated day", () => {
  it("scales the volume with the pool", () => {
    expect(episodesPerWeekday(OCCASIONAL_POOL_SIZE)).toBe(ONE_OFF_EPISODES_PER_WEEKDAY);
    expect(episodesPerWeekday(OCCASIONAL_POOL_SIZE * 5)).toBe(ONE_OFF_EPISODES_PER_WEEKDAY * 5);
    expect(isOccasionalPatient("occasional-0042")).toBe(true);
    expect(isOccasionalPatient("cmvziuyn3001")).toBe(false);
  });

  it("is the same on every run, with ids of the date and a prescription for each CPAM care", () => {
    const day = planOneOffDay(1, "2026-10-12", pool, facilities);
    expect(day).toEqual(planOneOffDay(1, "2026-10-12", pool, facilities));
    expect(day.episodes).toBeGreaterThan(5);
    expect(day.trips.every((t) => t.id.startsWith("hist-20261012-oneoff"))).toBe(true);
    expect(day.prescriptions.every((p) => String(p.id).startsWith("hist-20261012-rx"))).toBe(true);
    const prescriptionIds = new Set(day.prescriptions.map((p) => p.id));
    for (const trip of day.trips) {
      if (trip.payer === "CPAM") expect(prescriptionIds.has(trip.prescriptionId ?? "")).toBe(true);
      else expect(trip.prescriptionId).toBeNull();
    }
    expect(new Set(day.trips.map((t) => t.id)).size).toBe(day.trips.length);
  });

  it("leaves out patients of an unknown town and care in a facility that is gone, and has nothing on Sundays", () => {
    const strangers = pool.map((p) => ({ ...p, city: "Paris" }));
    expect(planOneOffDay(1, "2026-10-12", strangers, facilities).trips).toEqual([]);
    const none = planOneOffDay(1, "2026-10-12", pool, new Map());
    expect(none.trips.every((t) => t.payer === "PRIVATE")).toBe(true);
    expect(planOneOffDay(1, "2026-10-11", pool, facilities).trips).toEqual([]);
  });
});
