import { describe, expect, it } from "vitest";
import {
  buildNewTripData,
  cancelTripSchema,
  formValues,
  generateWeekSchema,
  parseNewTrip,
  prescriptionUsableOn,
  scheduleSchema,
  sharingDecisionSchema,
  SWAPPED_COORDINATES_MESSAGE,
  tollSchema,
  type NewTripValues,
} from "./trip-form";

const TODAY = "2026-11-02";

const cpamValues: NewTripValues = {
  patientId: "pat_1",
  payer: "CPAM",
  prescriptionId: "pre_1",
  direction: "OUTBOUND",
  facilityId: "fac_1",
  serviceDate: "2026-11-03",
  time: "07:30",
  notes: "",
};

// The first zod parse compiles the schema: slow on a cold machine.
describe("parseNewTrip", { timeout: 30_000 }, () => {
  it("accepts a complete CPAM trip", () => {
    const result = parseNewTrip(cpamValues, TODAY);
    expect(result).toEqual({
      ok: true,
      data: {
        patientId: "pat_1",
        payer: "CPAM",
        prescriptionId: "pre_1",
        direction: "OUTBOUND",
        facilityId: "fac_1",
        destinationAddress: undefined,
        destinationLat: undefined,
        destinationLng: undefined,
        serviceDate: "2026-11-03",
        time: 450,
        notes: undefined,
      },
    });
  });

  it("requires a prescription and a facility for a CPAM trip", () => {
    const result = parseNewTrip({ ...cpamValues, prescriptionId: "", facilityId: "" }, TODAY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.prescriptionId?.[0]).toMatch(/prescription/);
    expect(result.errors.facilityId?.[0]).toMatch(/établissement/);
  });

  it("reports field and cross-field errors together, in French", () => {
    const result = parseNewTrip({ payer: "CPAM", direction: "SIDEWAYS", serviceDate: "2026-02-30", time: "25:00" }, TODAY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.patientId).toEqual(["Choisissez un patient."]);
    expect(result.errors.direction).toEqual(["Choisissez le sens de la course."]);
    expect(result.errors.serviceDate).toEqual(["Date invalide."]);
    expect(result.errors.time).toEqual(["Heure invalide (format HH:MM)."]);
    expect(result.errors.prescriptionId).toBeDefined();
    expect(result.errors.facilityId).toBeDefined();
  });

  it("refuses a date in the past", () => {
    const result = parseNewTrip({ ...cpamValues, serviceDate: "2026-11-01" }, TODAY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.serviceDate).toEqual(["La date ne peut pas être passée."]);
  });

  it("lets a private trip go to a free address, with coordinates typed as a pair", () => {
    const privateValues: NewTripValues = {
      ...cpamValues,
      payer: "PRIVATE",
      prescriptionId: "",
      facilityId: "",
      destinationAddress: "Gare Saint-Charles, 13001 Marseille",
      destinationLat: "43,3027",
      destinationLng: "5.3806",
    };
    const ok = parseNewTrip(privateValues, TODAY);
    expect(ok.ok && ok.data.destinationLat).toBeCloseTo(43.3027);

    const noAddress = parseNewTrip({ ...privateValues, destinationAddress: " " }, TODAY);
    expect(!noAddress.ok && noAddress.errors.destinationAddress?.[0]).toMatch(/adresse/);

    const half = parseNewTrip({ ...privateValues, destinationLng: "" }, TODAY);
    expect(!half.ok && half.errors.destinationLng).toEqual(["Saisissez la latitude et la longitude."]);

    const outOfRange = parseNewTrip({ ...privateValues, destinationLat: "123" }, TODAY);
    expect(!outOfRange.ok && outOfRange.errors.destinationLat?.[0]).toMatch(/Latitude invalide/);

    // Same ranges as the address forms: a point outside metropolitan France is refused.
    const abroad = parseNewTrip({ ...privateValues, destinationLat: "48.85", destinationLng: "-61.5" }, TODAY);
    expect(!abroad.ok && abroad.errors.destinationLng).toEqual(["Longitude invalide\u00a0: hors de France métropolitaine (entre -5,5 et 10)."]);
    expect(!abroad.ok && abroad.errors.destinationLat).toBeUndefined();

    const notANumber = parseNewTrip({ ...privateValues, destinationLat: "nord" }, TODAY);
    expect(!notANumber.ok && notANumber.errors.destinationLat).toEqual(["Latitude invalide\u00a0: nombre décimal attendu (ex. 43,2965)."]);

    // Latitude and longitude typed the wrong way round: one message that says so.
    const swapped = parseNewTrip({ ...privateValues, destinationLat: "5,3806", destinationLng: "43.3027" }, TODAY);
    expect(!swapped.ok && swapped.errors.destinationLat).toEqual([SWAPPED_COORDINATES_MESSAGE]);
    expect(!swapped.ok && swapped.errors.destinationLng).toBeUndefined();

    // Coordinates may be left empty (geocoded by the server).
    expect(parseNewTrip({ ...privateValues, destinationLat: "", destinationLng: "" }, TODAY).ok).toBe(true);
  });
});

describe("buildNewTripData", () => {
  const patient = { id: "pat_1", address: "3 rue Paradis", postalCode: "13001", city: "Marseille", lat: 43.29, lng: 5.37 };
  const facility = { facilityId: "fac_1", address: "Centre de dialyse, 13005 Marseille", lat: 43.3, lng: 5.4 };
  const tap = { id: "pre_1", mode: "TAP" as const, sharing: "OUTBOUND" as const };

  it("derives an outbound CPAM trip from the prescription", () => {
    const data = buildNewTripData(
      { payer: "CPAM", direction: "OUTBOUND", serviceDate: "2026-11-03", time: 450, notes: undefined },
      patient,
      tap,
      facility,
    );
    expect(data).toMatchObject({
      serviceDate: new Date("2026-11-03T00:00:00.000Z"),
      direction: "OUTBOUND",
      patientId: "pat_1",
      prescriptionId: "pre_1",
      facilityId: "fac_1",
      payer: "CPAM",
      allowedVehicleTypes: ["TAXI", "VSL"],
      pickupAddress: "3 rue Paradis, 13001 Marseille",
      pickupLat: 43.29,
      dropoffAddress: "Centre de dialyse, 13005 Marseille",
      dropoffLng: 5.4,
      appointmentMinute: 450,
      readyMinute: null,
      sharingAllowed: true,
      sharingStatus: "NOT_PROPOSED",
      notes: null,
    });
  });

  it("swaps the addresses on a return leg and applies the sharing scope", () => {
    const data = buildNewTripData(
      { payer: "CPAM", direction: "RETURN", serviceDate: "2026-11-03", time: 690, notes: "Fauteuil pliable" },
      patient,
      tap,
      facility,
    );
    expect(data).toMatchObject({
      pickupAddress: "Centre de dialyse, 13005 Marseille",
      dropoffAddress: "3 rue Paradis, 13001 Marseille",
      appointmentMinute: null,
      readyMinute: 690,
      sharingAllowed: false,
      sharingStatus: "NOT_ELIGIBLE",
      notes: "Fauteuil pliable",
    });
  });

  it("sends a lying patient by ambulance, never shared", () => {
    const data = buildNewTripData(
      { payer: "CPAM", direction: "OUTBOUND", serviceDate: "2026-11-03", time: 450, notes: undefined },
      patient,
      { id: "pre_2", mode: "AMBULANCE", sharing: "BOTH" },
      facility,
    );
    expect(data.allowedVehicleTypes).toEqual(["AMBULANCE"]);
    expect(data.sharingStatus).toBe("NOT_ELIGIBLE");
  });

  it("ignores any prescription on a private trip: taxi only, not shareable", () => {
    const data = buildNewTripData(
      { payer: "PRIVATE", direction: "OUTBOUND", serviceDate: "2026-11-03", time: 600, notes: undefined },
      patient,
      tap,
      { facilityId: null, address: "Gare Saint-Charles, 13001 Marseille", lat: 43.30, lng: 5.38 },
    );
    expect(data).toMatchObject({
      prescriptionId: null,
      facilityId: null,
      allowedVehicleTypes: ["TAXI"],
      sharingAllowed: false,
      sharingStatus: "NOT_ELIGIBLE",
      dropoffAddress: "Gare Saint-Charles, 13001 Marseille",
    });
  });
});

describe("prescriptionUsableOn", () => {
  const prescription = {
    patientId: "pat_1",
    validFrom: new Date("2026-11-01T00:00:00.000Z"),
    validTo: new Date("2026-11-30T00:00:00.000Z"),
  };
  it("checks owner and dates", () => {
    expect(prescriptionUsableOn(prescription, "pat_1", "2026-11-30")).toBe(true);
    expect(prescriptionUsableOn(prescription, "pat_2", "2026-11-03")).toBe(false);
    expect(prescriptionUsableOn(prescription, "pat_1", "2026-12-01")).toBe(false);
  });
});

describe("row action schemas", () => {
  it("parses a new time", () => {
    expect(scheduleSchema.parse({ tripId: "t1", time: "08:15" })).toEqual({ tripId: "t1", time: 495 });
    expect(scheduleSchema.safeParse({ tripId: "t1", time: "8h15" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ tripId: "", time: "08:15" }).success).toBe(false);
  });

  it("parses a sharing decision with an optional note", () => {
    expect(sharingDecisionSchema.parse({ tripId: "t1", decision: "REFUSED", note: "  Préfère seul " })).toEqual({
      tripId: "t1",
      decision: "REFUSED",
      note: "Préfère seul",
    });
    expect(sharingDecisionSchema.parse({ tripId: "t1", decision: "ACCEPTED", note: "" }).note).toBeUndefined();
    expect(sharingDecisionSchema.safeParse({ tripId: "t1", decision: "NOT_ELIGIBLE" }).success).toBe(false);
    // The proposal is timestamped by the optimization, never recorded by hand.
    expect(sharingDecisionSchema.safeParse({ tripId: "t1", decision: "PROPOSED" }).success).toBe(false);
  });

  it("requires a reason to cancel a trip, and a note with «\u202fAutre motif\u202f»", () => {
    expect(cancelTripSchema.parse({ tripId: "t1", reason: "HOSPITALIZATION", note: " ", returnTripId: "" })).toEqual({
      tripId: "t1",
      reason: "HOSPITALIZATION",
      note: undefined,
      returnTripId: undefined,
    });
    expect(cancelTripSchema.parse({ tripId: "t1", reason: "PATIENT", returnTripId: "t2" }).returnTripId).toBe("t2");
    expect(cancelTripSchema.safeParse({ tripId: "t1", reason: "" }).error?.issues[0]?.message).toBe(
      "Choisissez le motif de l'annulation.",
    );
    expect(cancelTripSchema.safeParse({ tripId: "t1", reason: "OTHER", note: "" }).error?.issues[0]?.message).toBe(
      "Précisez le motif de l'annulation.",
    );
    expect(cancelTripSchema.safeParse({ tripId: "t1", reason: "OTHER", note: "Grève des transports" }).success).toBe(true);
    // The sync's own reason is never chosen by hand.
    expect(cancelTripSchema.safeParse({ tripId: "t1", reason: "REFERENTIAL_SYNC" }).success).toBe(false);
    expect(cancelTripSchema.safeParse({ tripId: "t1", reason: "PATIENT", note: "x".repeat(201) }).success).toBe(false);
  });

  it("generates weeks starting on a Monday only", () => {
    expect(generateWeekSchema.safeParse({ weekStart: "2026-11-02" }).success).toBe(true);
    expect(generateWeekSchema.safeParse({ weekStart: "2026-11-03" }).success).toBe(false);
    expect(generateWeekSchema.safeParse({ weekStart: "lundi" }).success).toBe(false);
  });

  it("reads string fields of a FormData", () => {
    const fd = new FormData();
    fd.set("tripId", "t1");
    fd.set("file", new Blob(["x"]));
    expect(formValues(fd, ["tripId", "file", "missing"])).toEqual({ tripId: "t1", file: undefined, missing: undefined });
  });
});

describe("tollSchema", () => {
  it("reads euros with a French comma, a blank or zero as no toll", () => {
    expect(tollSchema.parse({ tripId: "trip_1", toll: "4,20" })).toEqual({ tripId: "trip_1", toll: 4.2 });
    expect(tollSchema.parse({ tripId: "trip_1", toll: " " }).toll).toBeNull();
    expect(tollSchema.parse({ tripId: "trip_1", toll: "0" }).toll).toBeNull();
    expect(tollSchema.safeParse({ tripId: "trip_1", toll: "-2" }).success).toBe(false);
    expect(tollSchema.safeParse({ tripId: "trip_1", toll: "beaucoup" }).success).toBe(false);
  });
});
