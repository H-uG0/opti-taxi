import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fieldRecordLabel,
  fieldRecordText,
  recordedByText,
  sharingAnswerText,
  tariffGapList,
  tariffGapNote,
  UNKNOWN_AUTHOR,
} from "./format";

// Dates and times without a year are those of the current year (lib/time formatDateTime): the clock is set in 2026.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T12:00:00Z") });
});
afterAll(() => {
  vi.useRealTimers();
});

// November: Europe/Paris is UTC+1.
const DATE = "2026-11-03";

describe("recorded values", () => {
  it("names the account that recorded the value, or says it was not traced (as /courses)", () => {
    expect(recordedByText("Jean Martin")).toBe("par Jean Martin");
    expect(recordedByText(null)).toBe("auteur non tracé");
    expect(UNKNOWN_AUTHOR).toBe("auteur non tracé");
  });

  it("words the sharing answer as /courses does, with its time and author", () => {
    const at = "2026-11-02T16:40:00.000Z";
    expect(sharingAnswerText({ at, byName: "Marie Durand" }, "REFUSED")).toBe("Refus enregistré par Marie Durand le 02/11 à 17:40");
    expect(sharingAnswerText({ at, byName: "Marie Durand" }, "ACCEPTED")).toBe(
      "Acceptation enregistrée par Marie Durand le 02/11 à 17:40",
    );
    expect(sharingAnswerText({ at, byName: null }, "REFUSED")).toBe("Refus enregistré le 02/11 à 17:40 (auteur non tracé)");
    // Answer reset since (prescription changed): no answer to the current proposal, as on /courses.
    expect(sharingAnswerText({ at, byName: "Marie Durand" }, "NOT_ELIGIBLE")).toBeNull();
    expect(sharingAnswerText({ at, byName: "Marie Durand" }, "PROPOSED")).toBeNull();
  });

  it("labels a recorded stop as the crew recorded it, an absence on the pick-up of an absent patient", () => {
    expect(fieldRecordLabel("PICKUP", "PICKED_UP")).toBe("Prise en charge enregistrée");
    expect(fieldRecordLabel("PICKUP", "DROPPED_OFF")).toBe("Prise en charge enregistrée");
    expect(fieldRecordLabel("PICKUP", "NO_SHOW")).toBe("Absence enregistrée");
    expect(fieldRecordLabel("DROPOFF", "DROPPED_OFF")).toBe("Dépose enregistrée");
  });

  it("puts the author first, then the recorded time, as on /courses", () => {
    expect(fieldRecordText({ at: "2026-11-03T07:02:00.000Z", byName: "Jean Martin" }, DATE)).toBe("par Jean Martin · 08:02");
    expect(fieldRecordText({ at: "2026-11-04T08:00:00.000Z", byName: null }, DATE)).toBe("auteur non tracé · 04/11 à 09:00");
  });
});

describe("tariff gaps", () => {
  const gaps = [
    { vehicleType: "VSL" as const, department: "04", vehicles: ["VSL 2", "VSL 5"] },
    { vehicleType: "TAXI" as const, department: "05", vehicles: ["Taxi 9"] },
  ];

  it("lists each zone with its vehicles, and a short note for the optimization message", () => {
    expect(tariffGapList(gaps)).toBe("VSL 04 — VSL 2, VSL 5 ; Taxi 05 — Taxi 9");
    expect(tariffGapNote(gaps)).toBe("sans grille tarifaire : VSL 04, Taxi 05 (CA estimé à 0 €)");
    expect(tariffGapNote([])).toBe("");
  });
});
