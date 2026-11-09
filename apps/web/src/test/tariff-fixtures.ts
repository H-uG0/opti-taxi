/**
 * Tariff grid rows for the tests: a simple taxi grid of the 13 by default
 * (13 €, 1.12 €/km, sharing discounts of 23 and 35 %, no surcharge), every
 * column of TariffGrid filled. Override what a test needs.
 */
import type { TariffGrid } from "@prisma/client";

let nextId = 1;

export function tariffRow(overrides: Partial<TariffGrid> = {}): TariffGrid {
  return {
    id: `grid_${nextId++}`,
    vehicleType: "TAXI",
    department: "13",
    certified: null,
    zone: null,
    label: null,
    baseFare: 13,
    aggloFare: null,
    bigCityFare: 0,
    includedKm: 0,
    pricePerKm: 1.12,
    shortTripBands: [],
    nightRate: 0,
    weekendRate: 0,
    nightStartMinute: 1200,
    nightEndMinute: 480,
    saturdayFromMinute: 720,
    surchargeShortTrip: true,
    emptyLegRateShort: 0,
    emptyLegRateLong: 0,
    emptyLegThresholdKm: 50,
    sharedDiscounts: [
      { patients: 2, rate: 0.23 },
      { patients: 3, rate: 0.35 },
    ],
    maxSharedPatients: 3,
    aloneDiscount: 0,
    aloneThresholdKm: 30,
    billableDetourKm: [],
    tpmrFare: 0,
    verification: "UNVERIFIED",
    sourceUrl: null,
    validFrom: new Date("2026-01-01T00:00:00Z"),
    validTo: null,
    notes: null,
    createdAt: new Date("2025-12-01T00:00:00Z"),
    updatedAt: new Date("2025-12-01T00:00:00Z"),
    ...overrides,
  };
}
