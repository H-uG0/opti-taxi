import { describe, expect, it } from "vitest";
import { tripLineText } from "./naming";

describe("tripLineText", () => {
  const trip = { patientName: "ISNARD Gabriel", direction: "RETURN" as const, appointmentMinute: null, readyMinute: 600 };

  it("names a trip by its patient and leg", () => {
    expect(tripLineText(trip)).toBe("ISNARD Gabriel (retour, fin 10:00)");
    expect(tripLineText({ ...trip, direction: "OUTBOUND", appointmentMinute: 840 })).toBe("ISNARD Gabriel (aller, RDV 14:00)");
  });

  it("names a continuation by the patient waiting, never by an end of session (DAY-03)", () => {
    expect(tripLineText({ ...trip, readyMinute: 680, continuation: { interruptedAtMinute: 660 } })).toBe(
      "ISNARD Gabriel (reprise du retour, en attente depuis 11:00)",
    );
    expect(tripLineText({ ...trip, direction: "OUTBOUND", appointmentMinute: 840, continuation: { interruptedAtMinute: null } })).toBe(
      "ISNARD Gabriel (reprise de l'aller, RDV 14:00, en attente)",
    );
  });
});
