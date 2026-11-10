/**
 * View models of the planning screen for the interface tests (fictitious):
 * two vehicles of Marseille, a shared outbound pair on the taxi, a trip left
 * unassigned. Override what a test needs.
 */
import type { StopView, TripView, VehicleRowView } from "@/lib/planning/types";

export function tripView(overrides: Partial<TripView> = {}): TripView {
  return {
    id: "trip-a",
    direction: "OUTBOUND",
    status: "ASSIGNED",
    payer: "CPAM",
    patientId: "patient-a",
    patientName: "Monique Aubert",
    patientPhone: "04 91 00 00 01",
    mobility: "SEATED",
    accessNotes: null,
    notes: null,
    facilityName: "Centre de dialyse des Oliviers (fictif)",
    facilityPhone: null,
    pickupAddress: "12 rue des Lilas, 13012 Marseille",
    dropoffAddress: "112 boulevard des Oliviers, 13012 Marseille",
    pickup: { lat: 43.31, lng: 5.41 },
    dropoff: { lat: 43.3, lng: 5.41 },
    appointmentMinute: 450,
    readyMinute: null,
    allowedVehicleTypes: ["TAXI", "VSL"],
    sharingAllowed: true,
    sharingStatus: "ACCEPTED",
    sharingAnswer: null,
    fieldRecords: [],
    lockedVehicleId: null,
    vehicleId: "taxi-1",
    plannedPickupMinute: 415,
    plannedDropoffMinute: 440,
    shared: true,
    coPassengerTripIds: ["trip-b"],
    directKm: 3.4,
    detourKm: 0.8,
    estimatedRevenue: 15.2,
    waitAtFacilityMin: 10,
    outboundNoShow: false,
    ...overrides,
  };
}

function stop(id: string, tripId: string, kind: StopView["kind"], sequence: number, minute: number): StopView {
  return {
    id,
    sequence,
    tripId,
    kind,
    lat: 43.3,
    lng: 5.4,
    address: kind === "PICKUP" ? "12 rue des Lilas, 13012 Marseille" : "112 boulevard des Oliviers, 13012 Marseille",
    arrivalMinute: minute,
    startMinute: minute,
    departureMinute: minute + 5,
    loadAfter: kind === "PICKUP" ? 1 : 0,
    completed: false,
  };
}

export function vehicleRow(overrides: Partial<VehicleRowView> = {}): VehicleRowView {
  return {
    id: "taxi-1",
    label: "Taxi 1 (Marseille)",
    registration: "GH-218-PZ",
    type: "TAXI",
    capacity: 2,
    color: "#c27c0e",
    depot: { id: "depot-marseille", lat: 43.3, lng: 5.4, label: "Marseille" },
    driverName: "Julien Marchetti",
    crewMateName: null,
    available: true,
    unavailableReason: null,
    shift: { start: 360, end: 1110 },
    breakWindow: { start: 690, end: 840, duration: 45 },
    route: {
      id: "route-1",
      status: "PROPOSED",
      startMinute: 400,
      endMinute: 470,
      distanceKm: 18.4,
      emptyKm: 6.2,
      revenue: 30.4,
      cost: 34.1,
      margin: -3.7,
      breakStartMinute: null,
      breakEndMinute: null,
      validatedAt: null,
      tripCount: 2,
      stops: [
        stop("s1", "trip-a", "PICKUP", 1, 410),
        stop("s2", "trip-b", "PICKUP", 2, 420),
        stop("s3", "trip-a", "DROPOFF", 3, 440),
        stop("s4", "trip-b", "DROPOFF", 4, 441),
      ],
      driverId: "driver-1",
      crewMateId: null,
      remaining: { start: 400, end: 470 },
    },
    ...overrides,
  };
}

/** The taxi with its shared pair, a free VSL, an ambulance, and a VSL off the road. */
export function planningFixture() {
  const tripA = tripView();
  const tripB = tripView({ id: "trip-b", patientId: "patient-b", patientName: "Gérard Blanc", coPassengerTripIds: ["trip-a"] });
  const unassigned = tripView({
    id: "trip-c",
    patientId: "patient-c",
    patientName: "Colette Imbert",
    vehicleId: null,
    status: "PLANNED",
    shared: false,
    coPassengerTripIds: [],
    plannedPickupMinute: null,
    plannedDropoffMinute: null,
  });
  const vehicles: VehicleRowView[] = [
    vehicleRow(),
    vehicleRow({ id: "vsl-1", label: "VSL 1 (Marseille)", type: "VSL", driverName: "Élodie Fabre", route: null }),
    vehicleRow({ id: "amb-1", label: "Ambulance 1 (Marseille)", type: "AMBULANCE", capacity: 1, crewMateName: "Laurent Giraud", route: null }),
    vehicleRow({
      id: "vsl-2",
      label: "VSL 2 (Manosque)",
      type: "VSL",
      depot: { id: "depot-manosque", lat: 43.83, lng: 5.79, label: "Manosque" },
      route: null,
      available: false,
      unavailableReason: "révision au garage",
    }),
  ];
  return { trips: { [tripA.id]: tripA, [tripB.id]: tripB, [unassigned.id]: unassigned }, vehicles };
}
