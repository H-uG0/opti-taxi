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
  "DETOUR",
  "SHIFT",
  "BREAK",
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
  traffic: trafficSettingsSchema.nullish(),
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
  })
  .refine((t) => t.direction !== "OUTBOUND" || t.appointmentMin !== null, {
    message: "OUTBOUND trip requires appointmentMin",
  })
  .refine((t) => t.direction !== "RETURN" || t.readyMin !== null, {
    message: "RETURN trip requires readyMin",
  });

export const tariffSchema = z.strictObject({
  vehicleType: vehicleTypeSchema,
  department: z.string().min(1),
  baseFare: z.number().min(0),
  pricePerKm: z.number().min(0),
  includedKm: z.number().min(0).default(0),
  sharedDiscount2: z.number().min(0).max(1),
  sharedDiscount3: z.number().min(0).max(1),
});

/**
 * Bounds of a request (a 120-vehicle day is about 1 000 trips), the same in
 * services/optimizer/app/schemas.py: the optimizer refuses more with 422.
 */
export const MAX_VEHICLES = 300;
export const MAX_TRIPS = 3000;
export const MAX_TARIFFS = 500;

export const optimizeRequestSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  settings: settingsSchema,
  vehicles: z.array(vehicleSchema).max(MAX_VEHICLES, `${MAX_VEHICLES} véhicules au plus par calcul`),
  trips: z.array(tripSchema).max(MAX_TRIPS, `${MAX_TRIPS} courses au plus par calcul`),
  tariffs: z.array(tariffSchema).max(MAX_TARIFFS, `${MAX_TARIFFS} grilles tarifaires au plus par calcul`),
});

export const stopRefSchema = z.strictObject({
  tripId: z.string(),
  kind: stopKindSchema,
});

export const routePlanSchema = z.strictObject({
  vehicleId: z.string(),
  stops: z.array(stopRefSchema).max(2 * MAX_TRIPS),
});

export const evaluateRequestSchema = optimizeRequestSchema.extend({
  routes: z.array(routePlanSchema).max(MAX_VEHICLES, `${MAX_VEHICLES} tournées au plus par évaluation`),
});

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
export type OptimizeRequest = z.input<typeof optimizeRequestSchema>;
export type EvaluateRequest = z.input<typeof evaluateRequestSchema>;
export type RoutePlan = z.infer<typeof routePlanSchema>;
export type PlanResponse = z.infer<typeof planResponseSchema>;
export type PlanRoute = z.infer<typeof routeSchema>;
export type PlanStop = z.infer<typeof stopSchema>;
export type TripResult = z.infer<typeof tripResultSchema>;
export type PlanKpis = z.infer<typeof kpisSchema>;
export type Violation = z.infer<typeof violationSchema>;
