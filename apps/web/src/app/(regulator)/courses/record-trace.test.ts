import { describe, expect, it } from "vitest";
import {
  cancellationTrace,
  formatDayTime,
  outboundNoShowTrace,
  recordTrace,
  sharingAnswerTrace,
  stopStatusTraces,
  type CompletedStop,
} from "./record-trace";

const AT = new Date("2026-11-03T07:12:00Z"); // 08:12 in Paris (winter time)
const PICKED = new Date("2026-11-04T06:40:00Z"); // 07:40 in Paris
const DROPPED = new Date("2026-11-04T07:05:00Z"); // 08:05 in Paris

describe("formatDayTime", () => {
  it("formats day, month and time in Europe/Paris", () => {
    expect(formatDayTime(AT)).toBe("03/11 à 08:12");
    expect(formatDayTime(new Date("2026-07-14T21:30:00Z"))).toBe("14/07 à 23:30"); // summer time
    expect(formatDayTime(new Date("2026-11-03T23:05:00Z"))).toBe("04/11 à 00:05"); // next day in Paris, 00 not 24
  });
});

describe("recordTrace", () => {
  it("names who recorded it, and when", () => {
    expect(recordTrace("Refus enregistré", AT, "Marie Durand")).toEqual({
      full: "Refus enregistré par Marie Durand le 03/11 à 08:12",
      short: "par Marie Durand · 03/11 à 08:12",
    });
  });

  it("says when the author is unknown", () => {
    expect(recordTrace("Refus enregistré", AT, null)).toEqual({
      full: "Refus enregistré le 03/11 à 08:12 (auteur non tracé)",
      short: "auteur non tracé · 03/11 à 08:12",
    });
    expect(recordTrace("Refus enregistré", AT, "  ").full).toBe("Refus enregistré le 03/11 à 08:12 (auteur non tracé)");
  });
});

describe("sharingAnswerTrace", () => {
  const by = { name: "Marie Durand" };

  it("traces a refusal and an acceptance", () => {
    expect(sharingAnswerTrace({ sharingStatus: "REFUSED", sharingRespondedAt: AT, sharingRespondedBy: by })?.full).toBe(
      "Refus enregistré par Marie Durand le 03/11 à 08:12",
    );
    expect(sharingAnswerTrace({ sharingStatus: "ACCEPTED", sharingRespondedAt: AT, sharingRespondedBy: by })?.full).toBe(
      "Acceptation enregistrée par Marie Durand le 03/11 à 08:12",
    );
  });

  it("has nothing to say without an answer", () => {
    expect(sharingAnswerTrace({ sharingStatus: "PROPOSED", sharingRespondedAt: null, sharingRespondedBy: null })).toBeNull();
  });

  it("shows no answer once it was reset, whatever time or author it left", () => {
    for (const sharingStatus of ["NOT_ELIGIBLE", "NOT_PROPOSED", "PROPOSED"] as const) {
      expect(sharingAnswerTrace({ sharingStatus, sharingRespondedAt: AT, sharingRespondedBy: by })).toBeNull();
      expect(sharingAnswerTrace({ sharingStatus, sharingRespondedAt: AT, sharingRespondedBy: null })).toBeNull();
    }
  });
});

describe("stopStatusTraces", () => {
  const driver = { name: "Jean Martin" };
  const crewMate = { name: "Paul Roux" };
  const pickup: CompletedStop = { kind: "PICKUP", completedAt: PICKED, completedBy: driver };
  const dropoff: CompletedStop = { kind: "DROPOFF", completedAt: DROPPED, completedBy: crewMate };

  it("traces the pickup of a patient on board", () => {
    expect(stopStatusTraces("PICKED_UP", [pickup]).map((t) => t.full)).toEqual([
      "Prise en charge enregistrée par Jean Martin le 04/11 à 07:40",
    ]);
  });

  it("traces pickup then dropoff, whatever the order of the stops", () => {
    expect(stopStatusTraces("DROPPED_OFF", [dropoff, pickup]).map((t) => t.full)).toEqual([
      "Prise en charge enregistrée par Jean Martin le 04/11 à 07:40",
      "Dépose enregistrée par Paul Roux le 04/11 à 08:05",
    ]);
  });

  it("traces an absence on the pickup stop", () => {
    expect(stopStatusTraces("NO_SHOW", [pickup, { kind: "DROPOFF", completedAt: null, completedBy: null }])).toEqual([
      { full: "Absence enregistrée par Jean Martin le 04/11 à 07:40", short: "par Jean Martin · 04/11 à 07:40" },
    ]);
  });

  it("ignores stops without a recorded time and trips not started", () => {
    expect(stopStatusTraces("PICKED_UP", [{ kind: "PICKUP", completedAt: null, completedBy: driver }])).toEqual([]);
    expect(stopStatusTraces("ASSIGNED", [pickup])).toEqual([]);
    expect(stopStatusTraces("CANCELLED", [pickup, dropoff])).toEqual([]);
  });

  it("says when the crew member is unknown", () => {
    expect(stopStatusTraces("PICKED_UP", [{ ...pickup, completedBy: null }])[0]?.full).toBe(
      "Prise en charge enregistrée le 04/11 à 07:40 (auteur non tracé)",
    );
  });
});

describe("outboundNoShowTrace", () => {
  const driver = { name: "Jean Martin" };
  const leg = { patientId: "pat_1", recurrenceId: "rec_1", facilityId: "fac_1" };
  const absentOutbound = {
    ...leg,
    direction: "OUTBOUND" as const,
    status: "NO_SHOW" as const,
    stops: [{ kind: "PICKUP" as const, completedAt: PICKED, completedBy: driver }],
  };

  it("names who recorded the absence on the outbound leg of the same episode", () => {
    expect(outboundNoShowTrace(leg, [absentOutbound])).toEqual({
      full: "Absence à l'aller enregistrée par Jean Martin le 04/11 à 07:40",
      short: "par Jean Martin · 04/11 à 07:40",
    });
  });

  it("says when the crew member is unknown", () => {
    const untraced = { ...absentOutbound, stops: [{ kind: "PICKUP" as const, completedAt: PICKED, completedBy: null }] };
    expect(outboundNoShowTrace(leg, [untraced])?.full).toBe("Absence à l'aller enregistrée le 04/11 à 07:40 (auteur non tracé)");
  });

  it("ignores other patients, other episodes, other statuses and untraced absences", () => {
    expect(outboundNoShowTrace(leg, [{ ...absentOutbound, patientId: "pat_2" }])).toBeNull();
    expect(outboundNoShowTrace(leg, [{ ...absentOutbound, recurrenceId: "rec_2" }])).toBeNull();
    expect(outboundNoShowTrace(leg, [{ ...absentOutbound, status: "DROPPED_OFF" }])).toBeNull();
    expect(outboundNoShowTrace(leg, [{ ...absentOutbound, direction: "RETURN" }])).toBeNull();
    expect(outboundNoShowTrace(leg, [{ ...absentOutbound, stops: [] }])).toBeNull();
  });

  it("takes the first traced absence of the episode", () => {
    const later = { ...absentOutbound, stops: [{ kind: "PICKUP" as const, completedAt: DROPPED, completedBy: { name: "Paul Roux" } }] };
    expect(outboundNoShowTrace(leg, [{ ...absentOutbound, stops: [] }, later])?.full).toBe(
      "Absence à l'aller enregistrée par Paul Roux le 04/11 à 08:05",
    );
  });
});

describe("cancellationTrace", () => {
  const cancelled = { status: "CANCELLED" as const, cancelledAt: AT, cancelledBy: { name: "Marie Durand" } };

  it("says who cancelled the trip and when, or that the application did after their change", () => {
    expect(cancellationTrace({ ...cancelled, cancellationOrigin: "USER" })?.full).toBe(
      "Annulation enregistrée par Marie Durand le 03/11 à 08:12",
    );
    expect(cancellationTrace({ ...cancelled, cancellationOrigin: "SYSTEM" })?.full).toBe(
      "Annulation automatique (modification du référentiel) par Marie Durand le 03/11 à 08:12",
    );
  });

  it("is null for a trip not cancelled, or cancelled before the instant was recorded", () => {
    expect(cancellationTrace({ ...cancelled, status: "PLANNED", cancellationOrigin: null })).toBeNull();
    expect(cancellationTrace({ ...cancelled, cancelledAt: null, cancellationOrigin: null })).toBeNull();
  });
});
