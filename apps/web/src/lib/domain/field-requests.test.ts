import { describe, expect, it } from "vitest";
import {
  fieldRequestCrewText,
  fieldRequestText,
  nextSessionIssue,
  readyMinuteIssue,
  requestLeg,
  returnTripData,
  type OutboundForReturn,
} from "./field-requests";

describe("readyMinuteIssue", () => {
  it("accepts an end of session within the day, after the appointment", () => {
    expect(readyMinuteIssue(700, 600)).toBeNull();
    expect(readyMinuteIssue(600, 600)).toBeNull();
    expect(readyMinuteIssue(700, null)).toBeNull();
  });

  it("refuses a time outside the day or before the appointment", () => {
    expect(readyMinuteIssue(-1, null)).toBe("Heure invalide.");
    expect(readyMinuteIssue(1440, null)).toBe("Heure invalide.");
    expect(readyMinuteIssue(12.5, null)).toBe("Heure invalide.");
    expect(readyMinuteIssue(590, 600)).toBe("La séance ne peut pas finir avant le rendez-vous (10:00).");
  });
});

describe("nextSessionIssue", () => {
  it("wants a date after the day of service, within 120 days", () => {
    expect(nextSessionIssue("2026-11-18", "2026-11-16")).toBeNull();
    expect(nextSessionIssue("2026-11-16", "2026-11-16")).toBe("La prochaine séance doit être après aujourd'hui.");
    expect(nextSessionIssue("2027-04-01", "2026-11-16")).toBe("La prochaine séance doit être dans les 120 jours.");
  });
});

describe("fieldRequestText", () => {
  const base = { readyMinute: null, previousReadyMinute: null, cancellationReason: null, nextSessionDate: null };
  it("says what was signalled or asked, without naming the patient", () => {
    expect(fieldRequestText({ ...base, kind: "READY_TIME", readyMinute: 680, previousReadyMinute: 705 })).toBe("Patient prêt à 11:20 (prévu 11:45)");
    expect(fieldRequestText({ ...base, kind: "CANCEL", cancellationReason: "HOSPITALIZATION" })).toBe("Annulation demandée\u00a0: patient hospitalisé");
    expect(fieldRequestText({ ...base, kind: "CANCEL", cancellationReason: "DECEASED" })).toBe("Annulation demandée");
    expect(fieldRequestText({ ...base, kind: "RETURN", readyMinute: 930 })).toBe("Retour demandé, patient prêt à 15:30");
    expect(fieldRequestText({ ...base, kind: "NEXT_SESSION", nextSessionDate: "2026-11-20" })).toBe("Prochaine séance le 20/11/2026");
  });

  it("tells the crew where its request stands", () => {
    expect(fieldRequestCrewText({ ...base, kind: "READY_TIME", status: "PENDING", readyMinute: 680 }, "10:05")).toBe(
      "Patient prêt à 11:20 · envoyé à 10:05, transmis à la régulation",
    );
    expect(fieldRequestCrewText({ ...base, kind: "CANCEL", status: "REFUSED" }, "10:05")).toBe(
      "Annulation demandée · envoyé à 10:05, refusée par la régulation",
    );
  });

  it("names the leg each kind concerns", () => {
    expect(requestLeg("READY_TIME")).toBe("RETURN");
    expect(requestLeg("RETURN")).toBe("OUTBOUND");
    expect(requestLeg("CANCEL")).toBeNull();
  });
});

describe("returnTripData", () => {
  const outbound: OutboundForReturn = {
    serviceDate: new Date("2026-11-16T00:00:00Z"),
    patientId: "p1",
    prescriptionId: "rx1",
    facilityId: "f1",
    payer: "CPAM",
    allowedVehicleTypes: ["TAXI", "VSL"],
    oneOffAddress: false,
    pickupAddress: "Domicile",
    pickupLat: 43.1,
    pickupLng: 5.1,
    dropoffAddress: "Centre de dialyse",
    dropoffLat: 43.3,
    dropoffLng: 5.4,
    returnSharingAllowed: true,
  };

  it("brings the patient back from the care place to where the outbound picked them up, ready at the time asked", () => {
    expect(returnTripData(outbound, 930, "Retour demandé par l'équipage.")).toEqual({
      serviceDate: outbound.serviceDate,
      direction: "RETURN",
      patientId: "p1",
      prescriptionId: "rx1",
      facilityId: "f1",
      payer: "CPAM",
      allowedVehicleTypes: ["TAXI", "VSL"],
      oneOffAddress: false,
      pickupAddress: "Centre de dialyse",
      pickupLat: 43.3,
      pickupLng: 5.4,
      dropoffAddress: "Domicile",
      dropoffLat: 43.1,
      dropoffLng: 5.1,
      appointmentMinute: null,
      readyMinute: 930,
      sharingAllowed: true,
      sharingStatus: "NOT_PROPOSED",
      notes: "Retour demandé par l'équipage.",
    });
  });

  it("marks the return not eligible to sharing when the prescription does not allow it on the way back", () => {
    expect(returnTripData({ ...outbound, returnSharingAllowed: false }, 930, "").sharingStatus).toBe("NOT_ELIGIBLE");
  });
});
