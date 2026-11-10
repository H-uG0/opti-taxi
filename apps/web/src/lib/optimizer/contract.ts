/**
 * Wire contract between the web app and the optimizer (v1).
 *
 * Mirror of services/optimizer/app/schemas.py. Both must accept every file in
 * contract/fixtures. See contract/README.md for field semantics and units:
 * times are integer minutes since local midnight, distances km, money euros.
 */
import { z } from "zod";

const MINUTES_PER_DAY = 24 * 60;
const dayMinute = z.number().int().min(0).max(2 * MINUTES_PER_DAY);
/** Stop duration of one trip (Trip.pickupServiceMin / dropoffServiceMin), same bound in schemas.py. */
export const MAX_TRIP_SERVICE_MIN = 120;
const tripServiceMinutes = z.number().int().min(0).max(MAX_TRIP_SERVICE_MIN);
/** settings.maxRideExtraMin when the request leaves it out (DEFAULT_MAX_RIDE_EXTRA_MIN in schemas.py). */
export const DEFAULT_MAX_RIDE_EXTRA_MIN = 30;

export const vehicleTypeSchema = z.enum(["TAXI", "VSL", "AMBULANCE"]);
export const directionSchema = z.enum(["OUTBOUND", "RETURN"]);
export const stopKindSchema = z.enum(["PICKUP", "DROPOFF"]);
export const violationCodeSchema = z.enum([
  "UNKNOWN_REFERENCE",
  "DUPLICATE_TRIP",
  "PAIRING",
  "LOCK",
  "VEHICLE_TYPE",
  "CAPACITY",
  "EXCLUSIVE_RIDE",
  "TIME_WINDOW",
  "TOTAL_WAIT",
  "RIDE_TIME",
  "DETOUR",
  "SHIFT",
  "BREAK",
  "REVENUE",
]);

export const latLngSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const trafficFactor = z.number().min(1).max(5);

export const trafficSettingsSchema = z
  .strictObject({
    bands: z
      .array(
        z
          .strictObject({ startMin: dayMinute, endMin: dayMinute })
          .refine((band) => band.endMin > band.startMin, { message: "traffic band endMin must be after startMin" }),
      )
      .min(1),
    roadFactors: z.array(trafficFactor),
    zones: z.array(
      z.strictObject({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusKm: z.number().gt(0).max(100),
        factors: z.array(trafficFactor),
      }),
    ),
  })
  .refine((t) => t.bands.every((band, i) => i === 0 || band.startMin >= (t.bands[i - 1]?.endMin ?? 0)), {
    message: "traffic bands must be sorted and must not overlap",
  })
  .refine((t) => t.roadFactors.length === t.bands.length && t.zones.every((zone) => zone.factors.length === t.bands.length), {
    message: "one traffic factor per band is required",
  });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Readings of the conventions the PO has not settled yet (contract/README.md, « Calcul du CA estimé »). */
export const pricingSettingsSchema = z.strictObject({
  /** Taxi empty-leg surcharge of a hospital-linked trip: NONE, or DEPOT (first pickup / last dropoff of the route). */
  emptyLeg: z.enum(["NONE", "DEPOT"]).default("NONE"),
  /** Empty-leg and night/weekend surcharges on the km fare: multiplied or added. */
  emptyLegOrder: z.enum(["MULTIPLICATIVE", "ADDITIVE"]).default("MULTIPLICATIVE"),
  /** Patients of a shared ride for its discount: 1 + distinct co-passengers, or most on board at once. */
  patientCount: z.enum(["DISTINCT", "MAX_ON_BOARD"]).default("DISTINCT"),
  /** Public holidays (weekend surcharge): at least the planned date and the next day. */
  publicHolidays: z.array(isoDate).max(400).default([]),
});

export const settingsSchema = z.strictObject({
  waitBeforeAppointmentMin: z.number().int().min(0).max(180),
  waitAfterSessionMin: z.number().int().min(0).max(180),
  maxTotalWaitMin: z.number().int().min(0).max(360),
  maxDetourKmPerExtraPatient: z.number().min(0),
  maxDetourKmTotal: z.number().min(0),
  pickupServiceMin: z.number().int().min(0).max(60),
  dropoffServiceMin: z.number().int().min(0).max(60),
  unassignedPenalty: z.number().min(0),
  timeLimitSec: z.number().int().min(1).max(600),
  /** Time on board (end of the pickup to start of the dropoff) above the direct drive allowed to a patient. */
  maxRideExtraMin: z.number().int().min(0).max(180).default(DEFAULT_MAX_RIDE_EXTRA_MIN),
  traffic: trafficSettingsSchema.nullish(),
  /** Absent or null: the defaults (no empty-leg surcharge, multiplied, distinct co-passengers, no holiday). */
  pricing: pricingSettingsSchema.nullish(),
});

export const breakRuleSchema = z
  .strictObject({
    windowStartMin: dayMinute,
    windowEndMin: dayMinute,
    durationMin: z.number().int().min(0).max(MINUTES_PER_DAY),
  })
  .refine((b) => b.windowEndMin - b.windowStartMin >= b.durationMin, {
    message: "break window shorter than break duration",
  });

export const vehicleSchema = z
  .strictObject({
    id: z.string().min(1),
    label: z.string(),
    type: vehicleTypeSchema,
    capacity: z.number().int().min(1).max(8),
    depot: latLngSchema,
    department: z.string().min(1),
    costPerKm: z.number().min(0),
    costPerHour: z.number().min(0),
    shiftStartMin: dayMinute,
    shiftEndMin: dayMinute,
    break: breakRuleSchema.nullable().default(null),
    /** Grid of the vehicle's trips, chosen by the web (lib/domain/tariffs.ts gridForVehicle); null: revenue 0. */
    tariffId: z.string().min(1).nullable().default(null),
    /** Fitted to carry a patient in their wheelchair (TPMR supplement of the grid). */
    tpmrEquipped: z.boolean().default(false),
  })
  .refine((v) => v.shiftEndMin > v.shiftStartMin, {
    message: "shiftEndMin must be after shiftStartMin",
  });

export const tripSchema = z
  .strictObject({
    id: z.string().min(1),
    patientId: z.string().min(1),
    facilityId: z.string().nullable().default(null),
    direction: directionSchema,
    pickup: latLngSchema,
    dropoff: latLngSchema,
    appointmentMin: dayMinute.nullable().default(null),
    readyMin: dayMinute.nullable().default(null),
    allowedVehicleTypes: z.array(vehicleTypeSchema).min(1),
    shareable: z.boolean(),
    lockedVehicleId: z.string().nullable().default(null),
    /** Stop durations of this trip (vehicle type, mobility, facility); absent or null: the settings'. */
    pickupServiceMin: tripServiceMinutes.nullish(),
    dropoffServiceMin: tripServiceMinutes.nullish(),
    /** Grid of this trip whatever the vehicle (seated trip exceptionally in an ambulance: the VSL grid). */
    tariffId: z.string().min(1).nullable().default(null),
    /** Picked up or dropped in a « Grande ville » area (bigCityFare added). */
    bigCity: z.boolean().default(false),
    /** Entirely inside the agglomeration of the company's head office (aggloFare instead of baseFare). */
    agglomeration: z.boolean().default(false),
    /** To or from a hospitalisation or a dialysis, chemotherapy or radiotherapy session (taxi empty leg). */
    hospitalLinked: z.boolean().default(false),
    /** The patient rides in their own wheelchair (TPMR supplement in a fitted vehicle). */
    wheelchair: z.boolean().default(false),
    /** Tolls billed on this patient's invoice (euros), outside surcharges and discounts. */
    tollAmount: z.number().min(0).max(1000).default(0),
  })
  .refine((t) => t.direction !== "OUTBOUND" || t.appointmentMin !== null, {
    message: "OUTBOUND trip requires appointmentMin",
  })
  .refine((t) => t.direction !== "RETURN" || t.readyMin !== null, {
    message: "RETURN trip requires readyMin",
  });

const rateValue = z.number().min(0).max(5);
const kmValue = z.number().min(0).max(1000);

/** One grid, as the web picked it for the vehicles and trips that reference its id. */
export const tariffSchema = z
  .strictObject({
    id: z.string().min(1),
    vehicleType: vehicleTypeSchema,
    baseFare: z.number().min(0).max(1000),
    /** Replaces baseFare for a trip inside the head office's agglomeration (ambulance). */
    aggloFare: z.number().min(0).max(1000).nullable().default(null),
    bigCityFare: z.number().min(0).max(1000).default(0),
    includedKm: kmValue.default(0),
    pricePerKm: z.number().min(0).max(50),
    /** Added to the fare: the first band whose upToKm is at least the billed km. */
    shortTripBands: z.array(z.strictObject({ upToKm: kmValue, amount: z.number().min(0).max(1000) })).max(50).default([]),
    nightRate: rateValue.default(0),
    weekendRate: rateValue.default(0),
    nightStartMin: z.number().int().min(0).max(MINUTES_PER_DAY).default(1200),
    nightEndMin: z.number().int().min(0).max(MINUTES_PER_DAY).default(480),
    saturdayFromMin: z.number().int().min(0).max(MINUTES_PER_DAY).default(720),
    surchargeShortTrip: z.boolean().default(true),
    emptyLegRateShort: rateValue.default(0),
    emptyLegRateLong: rateValue.default(0),
    emptyLegThresholdKm: kmValue.default(50),
    /** Discount by number of patients; the largest entry also covers more patients. */
    sharedDiscounts: z.array(z.strictObject({ patients: z.number().int().min(2).max(8), rate: z.number().min(0).max(1) })).max(7).default([]),
    maxSharedPatients: z.number().int().min(1).max(8).default(8),
    aloneDiscount: z.number().min(0).max(1).default(0),
    aloneThresholdKm: kmValue.default(30),
    /** Detour billed to a shared patient: at most the sum of the first k entries (k co-passengers). */
    billableDetourKm: z.array(kmValue).max(7).default([]),
    tpmrFare: z.number().min(0).max(1000).default(0),
  })
  .refine((t) => t.shortTripBands.every((band, i) => i === 0 || band.upToKm > (t.shortTripBands[i - 1]?.upToKm ?? 0)), {
    message: "shortTripBands must be sorted by increasing upToKm",
  })
  .refine((t) => new Set(t.sharedDiscounts.map((d) => d.patients)).size === t.sharedDiscounts.length, {
    message: "one sharedDiscounts entry per number of patients",
  });

/**
 * Bounds of a request (a 120-vehicle day is about 1 000 trips), the same in
 * services/optimizer/app/schemas.py: the optimizer refuses more with 422.
 */
export const MAX_VEHICLES = 300;
export const MAX_TRIPS = 3000;
export const MAX_TARIFFS = 500;

export const stopRefSchema = z.strictObject({
  tripId: z.string(),
  kind: stopKindSchema,
});

export const routePlanSchema = z.strictObject({
  vehicleId: z.string(),
  stops: z.array(stopRefSchema).max(2 * MAX_TRIPS),
});

/** What both operations need: the day's settings, fleet, trips and tariffs. */
const dayRequestFields = {
  date: isoDate,
  settings: settingsSchema,
  vehicles: z.array(vehicleSchema).max(MAX_VEHICLES, `${MAX_VEHICLES} véhicules au plus par calcul`),
  trips: z.array(tripSchema).max(MAX_TRIPS, `${MAX_TRIPS} courses au plus par calcul`),
  tariffs: z.array(tariffSchema).max(MAX_TARIFFS, `${MAX_TARIFFS} grilles tarifaires au plus par calcul`),
};

type TariffReferences = {
  vehicles: { tariffId?: string | null }[];
  trips: { tariffId?: string | null }[];
  tariffs: { id: string }[];
};

/** Tariff ids are unique and every vehicle or trip refers to one of them (same check in schemas.py). */
function tariffReferencesOk(request: TariffReferences): boolean {
  const ids = new Set(request.tariffs.map((t) => t.id));
  if (ids.size !== request.tariffs.length) return false;
  return [...request.vehicles, ...request.trips].every((item) => item.tariffId == null || ids.has(item.tariffId));
}

const TARIFF_REFERENCES = { message: "tariff ids must be unique and every tariffId must name one of them" };

export const dayRequestSchema = z.strictObject(dayRequestFields).refine(tariffReferencesOk, TARIFF_REFERENCES);

export const optimizeRequestSchema = z
  .strictObject({
    ...dayRequestFields,
    /**
     * The routes in place of the date, a start of the search: the plan returned
     * never scores worse than them, once repaired to the rules of the request,
     * under the optimizer's objective (contract/README.md, « Planning en
     * place »). Absent or null: none.
     */
    initialRoutes: z.array(routePlanSchema).max(MAX_VEHICLES, `${MAX_VEHICLES} tournées au plus en place`).nullish(),
  })
  .refine(tariffReferencesOk, TARIFF_REFERENCES);

export const evaluateRequestSchema = z
  .strictObject({
    ...dayRequestFields,
    routes: z.array(routePlanSchema).max(MAX_VEHICLES, `${MAX_VEHICLES} tournées au plus par évaluation`),
  })
  .refine(tariffReferencesOk, TARIFF_REFERENCES);

/**
 * POST /insert (contract/README.md, « InsertRequest et InsertResponse »): where one trip fits in the
 * routes in place, the other routes kept. The trip's own lock is ignored (the regulator places it).
 */
export const insertRequestSchema = z
  .strictObject({
    ...dayRequestFields,
    routes: z.array(routePlanSchema).max(MAX_VEHICLES, `${MAX_VEHICLES} tournées au plus en place`),
    /** The trip to place: on one of `routes` (a move), or on none (a trip without a vehicle). */
    tripId: z.string().min(1),
    /** Vehicles to try (« Appliquer », a drop on one vehicle); null or absent: every vehicle. */
    vehicleIds: z.array(z.string()).max(MAX_VEHICLES).nullish(),
  })
  .refine(tariffReferencesOk, TARIFF_REFERENCES)
  .refine((request) => request.trips.some((trip) => trip.id === request.tripId), { message: "tripId must name a trip of the request" });

export const breakSlotSchema = z.strictObject({
  startMin: z.number().int(),
  endMin: z.number().int(),
});

export const stopSchema = z.strictObject({
  tripId: z.string(),
  kind: stopKindSchema,
  location: latLngSchema,
  arrivalMin: z.number().int(),
  startMin: z.number().int(),
  departureMin: z.number().int(),
  loadAfter: z.number().int().min(0),
});

export const routeSchema = z.strictObject({
  vehicleId: z.string(),
  startMin: z.number().int(),
  endMin: z.number().int(),
  distanceKm: z.number(),
  emptyKm: z.number(),
  loadedKm: z.number(),
  durationMin: z.number().int(),
  revenue: z.number(),
  cost: z.number(),
  margin: z.number(),
  break: breakSlotSchema.nullable().default(null),
  stops: z.array(stopSchema),
});

export const tripResultSchema = z.strictObject({
  tripId: z.string(),
  vehicleId: z.string().nullable(),
  pickupMin: z.number().int().nullable(),
  dropoffMin: z.number().int().nullable(),
  shared: z.boolean(),
  coPassengerTripIds: z.array(z.string()),
  directKm: z.number(),
  rideKm: z.number(),
  detourKm: z.number(),
  revenue: z.number(),
  waitAtFacilityMin: z.number().int().nullable(),
});

export const unassignedSchema = z.strictObject({
  tripId: z.string(),
  reason: z.string(),
});

export const kpisSchema = z.strictObject({
  tripsTotal: z.number().int(),
  tripsServed: z.number().int(),
  tripsUnassigned: z.number().int(),
  vehiclesUsed: z.number().int(),
  tripsPerVehicle: z.number(),
  totalKm: z.number(),
  emptyKm: z.number(),
  emptyKmRatio: z.number(),
  sharedTrips: z.number().int(),
  sharedTripRatio: z.number(),
  revenue: z.number(),
  cost: z.number(),
  margin: z.number(),
});

export const violationSchema = z.strictObject({
  code: violationCodeSchema,
  message: z.string(),
  tripId: z.string().nullable().default(null),
  vehicleId: z.string().nullable().default(null),
});

export const planResponseSchema = z.strictObject({
  status: z.enum(["OK", "NO_SOLUTION"]),
  routes: z.array(routeSchema),
  trips: z.array(tripResultSchema),
  unassigned: z.array(unassignedSchema),
  kpis: kpisSchema,
  validation: z.strictObject({
    valid: z.boolean(),
    violations: z.array(violationSchema),
  }),
  meta: z.strictObject({
    matrixSource: z.enum(["osrm", "haversine"]),
    trafficSource: z.enum(["none", "factors"]),
    solverStatus: z.string(),
    objective: z.number().nullable(),
    wallTimeMs: z.number().int(),
    warnings: z.array(z.string()),
  }),
});

const planMetaSchema = planResponseSchema.shape.meta;

/** Why a vehicle cannot take the trip: its hours, its driver's break, its patients then, no room, or a rule. */
export const rejectionKindSchema = z.enum(["SHIFT", "BREAK", "OCCUPIED", "NO_ROOM", "RULES"]);

export const timeShiftSchema = z.strictObject({
  tripId: z.string(),
  pickupMin: z.number().int(),
  dropoffMin: z.number().int(),
  /** New minus former start (minutes, + later). */
  pickupShiftMin: z.number().int(),
  dropoffShiftMin: z.number().int(),
});

export const insertOptionSchema = z.strictObject({
  vehicleId: z.string(),
  pickupMin: z.number().int(),
  dropoffMin: z.number().int(),
  shared: z.boolean(),
  coPassengerTripIds: z.array(z.string()),
  deltaKm: z.number(),
  deltaEmptyKm: z.number(),
  deltaDurationMin: z.number().int(),
  deltaRevenue: z.number(),
  deltaCost: z.number(),
  deltaMargin: z.number(),
  shifts: z.array(timeShiftSchema),
  /** The target route with the trip and, for a move, the source without it (absent when left empty). */
  routes: z.array(routeSchema),
  /** Results of every trip of `routes`, the placed one included. */
  trips: z.array(tripResultSchema),
  /** Rules these routes already broke and still do (never a new one). */
  violations: z.array(violationSchema),
});

export const insertRejectionSchema = z.strictObject({
  vehicleId: z.string(),
  kind: rejectionKindSchema,
  /** French, to follow the vehicle's name: « est en pause de 12:00 à 12:45 ». */
  reason: z.string(),
});

export const insertResponseSchema = z.strictObject({
  tripId: z.string(),
  fromVehicleId: z.string().nullable(),
  /** Best margin first. */
  options: z.array(insertOptionSchema),
  rejected: z.array(insertRejectionSchema),
  meta: planMetaSchema,
});

export const healthSchema = z.strictObject({
  status: z.literal("ok"),
  matrixSource: z.enum(["osrm", "haversine"]),
});

export type VehicleType = z.infer<typeof vehicleTypeSchema>;
export type Direction = z.infer<typeof directionSchema>;
export type StopKind = z.infer<typeof stopKindSchema>;
export type ViolationCode = z.infer<typeof violationCodeSchema>;
export type LatLng = z.infer<typeof latLngSchema>;
export type OptimizerSettings = z.infer<typeof settingsSchema>;
export type OptimizerVehicle = z.input<typeof vehicleSchema>;
export type OptimizerTrip = z.input<typeof tripSchema>;
export type OptimizerTariff = z.input<typeof tariffSchema>;
export type OptimizerPricingSettings = z.input<typeof pricingSettingsSchema>;
/** The day part of a request (no `initialRoutes`, no `routes`): what /optimize and /evaluate share. */
export type DayRequest = z.input<typeof dayRequestSchema>;
export type OptimizeRequest = z.input<typeof optimizeRequestSchema>;
export type EvaluateRequest = z.input<typeof evaluateRequestSchema>;
export type RoutePlan = z.infer<typeof routePlanSchema>;
export type PlanResponse = z.infer<typeof planResponseSchema>;
export type PlanRoute = z.infer<typeof routeSchema>;
export type PlanStop = z.infer<typeof stopSchema>;
export type TripResult = z.infer<typeof tripResultSchema>;
export type PlanKpis = z.infer<typeof kpisSchema>;
export type Violation = z.infer<typeof violationSchema>;
export type InsertRequest = z.input<typeof insertRequestSchema>;
export type InsertResponse = z.infer<typeof insertResponseSchema>;
export type InsertOption = z.infer<typeof insertOptionSchema>;
export type InsertRejection = z.infer<typeof insertRejectionSchema>;
export type RejectionKind = z.infer<typeof rejectionKindSchema>;
export type TimeShift = z.infer<typeof timeShiftSchema>;
