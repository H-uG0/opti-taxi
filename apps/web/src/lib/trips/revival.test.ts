import { describe, expect, it } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { oneOffRevival, type OneOffRevivalTrip } from "./revival";

const HOME = { address: "4 rue Neuve", postalCode: "04100", city: "Manosque", lat: 43.83, lng: 5.79 };
const CARE = { address: "1 avenue de l'Hôpital", postalCode: "13100", city: "Aix-en-Provence", lat: 43.53, lng: 5.45 };

/** A CPAM consultation (outbound), cancelled when its patient was deactivated, since moved house. */
function trip(overrides: Partial<OneOffRevivalTrip> = {}): OneOffRevivalTrip {
  return {
    id: "t1",
    serviceDate: fromIsoDate("2026-11-12"),
    direction: "OUTBOUND",
    payer: "CPAM",
    sharingStatus: "NOT_PROPOSED",
    pickupAddress: "ancienne adresse",
    pickupLat: 43.1,
    pickupLng: 5.1,
    dropoffAddress: "1 avenue de l'Hôpital, 13100 Aix-en-Provence",
    dropoffLat: 43.53,
    dropoffLng: 5.45,
    patient: { ...HOME, active: true },
    prescription: { mode: "TAP", sharing: "BOTH", validFrom: fromIsoDate("2026-11-01"), validTo: fromIsoDate("2026-11-30") },
    facility: { ...CARE, active: true },
    ...overrides,
  };
}

describe("oneOffRevival", () => {
  it("brings the trip back from the patient's current home to the facility, with its prescription's rules", () => {
    expect(oneOffRevival(trip())).toMatchObject({
      status: "PLANNED",
      cancellationOrigin: null,
      cancellationReason: null,
      pickupAddress: "4 rue Neuve, 04100 Manosque",
      pickupLat: 43.83,
      dropoffAddress: "1 avenue de l'Hôpital, 13100 Aix-en-Provence",
      allowedVehicleTypes: ["TAXI", "VSL"],
      sharingAllowed: true,
      sharingStatus: "NOT_PROPOSED",
      routeId: null,
    });
  });

  it("waits while a cause holds: patient inactive, facility closed, prescription not covering the date", () => {
    expect(oneOffRevival(trip({ patient: { ...HOME, active: false } }))).toBeNull();
    expect(oneOffRevival(trip({ facility: { ...CARE, active: false } }))).toBeNull();
    expect(oneOffRevival(trip({ prescription: null }))).toBeNull();
    const ended = { mode: "TAP" as const, sharing: "BOTH" as const, validFrom: fromIsoDate("2026-10-01"), validTo: fromIsoDate("2026-11-11") };
    expect(oneOffRevival(trip({ prescription: ended }))).toBeNull();
  });

  it("keeps a private client's free destination, and a return comes back home", () => {
    const station = trip({ payer: "PRIVATE", prescription: null, facility: null, direction: "RETURN", pickupAddress: "Gare de Manosque" });
    expect(oneOffRevival(station)).toMatchObject({
      pickupAddress: "Gare de Manosque",
      dropoffAddress: "4 rue Neuve, 04100 Manosque",
      allowedVehicleTypes: ["TAXI"],
      sharingAllowed: false,
      sharingStatus: "NOT_ELIGIBLE",
    });
  });
});
