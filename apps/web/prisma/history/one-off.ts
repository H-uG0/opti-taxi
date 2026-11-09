/**
 * One-off trips of a simulated day (pure, unit-tested): consultations,
 * imaging, admissions, discharges and private clients of the seed's
 * occasional patients (ids "occasional-…", seed/one-off.ts), as on the seeded
 * days. Each care gets its one-off prescription, valid up to the day of the
 * care only (never offered for a trip created in the app afterwards); trips
 * and prescriptions get ids of the date (ids.ts) so that a re-run replaces
 * them. The volume follows
 * the size of the pool, at the seed's rates: ONE_OFF_EPISODES_PER_WEEKDAY for
 * the small data set's OCCASIONAL_POOL_SIZE patients, and those of --fleet
 * for the patients it adds.
 */
import type { Mobility, Prisma } from "@prisma/client";
import { fromIsoDate } from "@/lib/time";
import {
  FLEET_OCCASIONAL_POOL_SIZE,
  FLEET_ONE_OFF_EPISODES_PER_WEEKDAY,
  OCCASIONAL_POOL_SIZE,
  ONE_OFF_EPISODES_PER_WEEKDAY,
  TOWNS,
  type AnyFacilityKey,
  type TownKey,
} from "../seed/data";
import { drawEpisodes, episodeCount, episodePrescription, episodeTrips, OCCASIONAL_ID_PREFIX } from "../seed/one-off";
import { rngFor } from "./hash";
import { historyOneOffTripId, historyPrescriptionId } from "./ids";

export type PoolPatientRow = {
  id: string;
  mobility: Mobility;
  address: string;
  postalCode: string;
  city: string;
  lat: number;
  lng: number;
};

export type DestinationRow = { id: string; address: string; lat: number; lng: number };

export type OneOffDay = {
  prescriptions: Prisma.PrescriptionCreateManyInput[];
  trips: (Prisma.TripCreateManyInput & { id: string })[];
  episodes: number;
};

const TOWN_BY_NAME: ReadonlyMap<string, TownKey> = new Map(
  (Object.keys(TOWNS) as TownKey[]).map((key) => [TOWNS[key].name as string, key] as const),
);

/** Whether a patient belongs to the seed's pool of occasional patients. */
export function isOccasionalPatient(id: string): boolean {
  return id.startsWith(OCCASIONAL_ID_PREFIX);
}

/**
 * Episodes a weekday for a pool of `poolSize` patients, as the seed draws
 * them: the small data set's rate for its first OCCASIONAL_POOL_SIZE patients,
 * the large fleet's for the others.
 */
export function episodesPerWeekday(poolSize: number): number {
  const small = Math.min(poolSize, OCCASIONAL_POOL_SIZE);
  const fleet = Math.max(0, poolSize - OCCASIONAL_POOL_SIZE);
  return Math.round(
    (small * ONE_OFF_EPISODES_PER_WEEKDAY) / OCCASIONAL_POOL_SIZE + (fleet * FLEET_ONE_OFF_EPISODES_PER_WEEKDAY) / FLEET_OCCASIONAL_POOL_SIZE,
  );
}

/**
 * The one-off care of `isoDate`, drawn from the date only (rngFor): the same
 * on every run. Patients whose town is unknown (address changed in the app)
 * and care whose facility no longer exists are left out.
 */
export function planOneOffDay(
  seed: number,
  isoDate: string,
  pool: readonly PoolPatientRow[],
  facilities: ReadonlyMap<AnyFacilityKey, DestinationRow>,
): OneOffDay {
  const known = pool.flatMap((p) => {
    const town = TOWN_BY_NAME.get(p.city);
    return town ? [{ id: p.id, mobility: p.mobility, town, row: p }] : [];
  });
  const byId = new Map(known.map((p) => [p.id, p.row]));
  const rng = rngFor(seed, isoDate, "one-off");
  const count = episodeCount(episodesPerWeekday(known.length), isoDate, rng);
  const result: OneOffDay = { prescriptions: [], trips: [], episodes: 0 };
  for (const [index, episode] of drawEpisodes(known, count, rng).entries()) {
    const home = byId.get(episode.patientId);
    const facility = episode.facilityKey ? facilities.get(episode.facilityKey) : null;
    if (!home || facility === undefined) continue;
    const destination = facility ?? { id: null, ...(episode.place ?? { address: "", lat: 0, lng: 0 }) };
    const number = index + 1;
    const prescription = episodePrescription(episode, isoDate);
    const prescriptionId = prescription ? historyPrescriptionId(isoDate, number) : null;
    if (prescription && prescriptionId) {
      result.prescriptions.push({ ...prescription, validTo: fromIsoDate(isoDate), id: prescriptionId, patientId: episode.patientId });
    }
    for (const trip of episodeTrips(episode, home, destination, isoDate, prescriptionId)) {
      result.trips.push({ ...trip, id: historyOneOffTripId(isoDate, number, trip.direction) });
    }
    result.episodes++;
  }
  return result;
}
