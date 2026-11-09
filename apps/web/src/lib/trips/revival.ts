/**
 * A one-off trip (no recurrence) the application cancelled — its patient was
 * deactivated, its prescription no longer covered it — comes back once the
 * cause is gone. Pure (no server-only import): unit-tested.
 */
import type { Payer, PrescribedMode, Prisma, SharingScope, SharingStatus, TripDirection } from "@prisma/client";
import { NO_CANCELLATION } from "@/lib/domain/cancellation";
import { allowedVehicleTypesFor, formatAddress, nextSharingStatus, sharingAllowedFor } from "@/lib/domain/rules";
import { toIsoDate } from "@/lib/time";

type Place = { address: string; postalCode: string; city: string; lat: number; lng: number };

/** A cancelled one-off trip as reviveOneOffTrips loads it, with the current state of what it depends on. */
export type OneOffRevivalTrip = {
  id: string;
  serviceDate: Date;
  direction: TripDirection;
  payer: Payer;
  sharingStatus: SharingStatus;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropoffAddress: string;
  dropoffLat: number;
  dropoffLng: number;
  patient: Place & { active: boolean };
  prescription: { mode: PrescribedMode; sharing: SharingScope; validFrom: Date; validTo: Date } | null;
  facility: (Place & { active: boolean }) | null;
};

/**
 * What the trip becomes when it can come back, or null while a cause holds:
 * patient inactive, facility inactive, or a CPAM trip whose prescription no
 * longer covers its date. Places are taken again from the patient's home and
 * the facility (they may have moved meanwhile); rules from the prescription.
 */
export function oneOffRevival(trip: OneOffRevivalTrip): Prisma.TripUncheckedUpdateManyInput | null {
  if (!trip.patient.active) return null;
  if (trip.facility && !trip.facility.active) return null;
  const date = toIsoDate(trip.serviceDate);
  const prescription = trip.payer === "CPAM" ? trip.prescription : null;
  if (trip.payer === "CPAM") {
    if (!prescription || toIsoDate(prescription.validFrom) > date || date > toIsoDate(prescription.validTo)) return null;
  }
  const mode = prescription?.mode ?? null;
  const sharingAllowed = sharingAllowedFor(prescription?.sharing ?? null, trip.direction, mode, trip.payer);
  const home = { address: formatAddress(trip.patient), lat: trip.patient.lat, lng: trip.patient.lng };
  const care = trip.facility
    ? { address: formatAddress(trip.facility), lat: trip.facility.lat, lng: trip.facility.lng }
    : trip.direction === "OUTBOUND"
      ? { address: trip.dropoffAddress, lat: trip.dropoffLat, lng: trip.dropoffLng }
      : { address: trip.pickupAddress, lat: trip.pickupLat, lng: trip.pickupLng };
  const [pickup, dropoff] = trip.direction === "OUTBOUND" ? [home, care] : [care, home];
  return {
    status: "PLANNED",
    ...NO_CANCELLATION,
    allowedVehicleTypes: allowedVehicleTypesFor(mode, trip.payer),
    sharingAllowed,
    sharingStatus: nextSharingStatus(trip.sharingStatus, sharingAllowed),
    pickupAddress: pickup.address,
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    dropoffAddress: dropoff.address,
    dropoffLat: dropoff.lat,
    dropoffLng: dropoff.lng,
    routeId: null,
    lockedVehicleId: null,
    plannedPickupMinute: null,
    plannedDropoffMinute: null,
    shared: false,
    detourKm: null,
    estimatedRevenue: null,
  };
}
