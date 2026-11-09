import { describe, expect, it } from "vitest";
import { latenessShown, nextStopTiming, nextStopTimingText, plannedTapMinute, recordedLateness } from "./punctuality";

// A pickup reached at 08:00 (480) for service at 08:05 (485).
const pickup = { plannedArrivalMinute: 480, plannedMinute: 485, anchorArrivalMinute: null, appointmentMinute: null };

describe("nextStopTiming", () => {
  it("is on time while now and the route stay within 5 min of the plan", () => {
    expect(nextStopTiming({ ...pickup, nowMinute: 440 })).toEqual({ status: "on_time", minutes: 0, reference: "planned", expectedMinute: 480 });
    expect(nextStopTiming({ ...pickup, nowMinute: 490 })).toMatchObject({ status: "on_time", expectedMinute: 490 });
  });

  it("is late once the estimated arrival passes the planned time by more than 5 min", () => {
    expect(nextStopTiming({ ...pickup, nowMinute: 497 })).toEqual({ status: "late", minutes: 12, reference: "planned", expectedMinute: 497 });
    // Late from the latest status (08:10 for an 08:00 pickup, 12 min planned to here): even if now is early.
    expect(nextStopTiming({ ...pickup, nowMinute: 470, anchorArrivalMinute: 502 })).toMatchObject({ status: "late", minutes: 17 });
  });

  it("is early when the route runs ahead of the planned arrival by more than 5 min", () => {
    expect(nextStopTiming({ ...pickup, nowMinute: 440, anchorArrivalMinute: 468 })).toEqual({
      status: "early",
      minutes: 12,
      reference: "planned",
      expectedMinute: 468,
    });
    // Now is a floor: already at 08:00, nothing early about it.
    expect(nextStopTiming({ ...pickup, nowMinute: 480, anchorArrivalMinute: 468 }).status).toBe("on_time");
  });

  it("judges an outbound dropoff against the appointment", () => {
    // Dropoff planned at 08:15 (arrival 08:12) for an appointment at 08:30.
    const dropoff = { plannedArrivalMinute: 492, plannedMinute: 495, anchorArrivalMinute: null, appointmentMinute: 510 };
    // 08:28: late on the plan, still before the appointment: on time for it.
    expect(nextStopTiming({ ...dropoff, nowMinute: 508 })).toEqual({ status: "on_time", minutes: 0, reference: "appointment", expectedMinute: 508 });
    expect(nextStopTiming({ ...dropoff, nowMinute: 517 })).toEqual({ status: "late", minutes: 7, reference: "appointment", expectedMinute: 517 });
  });

  it("says it in words", () => {
    expect(nextStopTimingText({ status: "late", minutes: 12, reference: "planned", expectedMinute: 0 })).toBe(
      "En retard sur le planning : environ 12\u00a0min",
    );
    expect(nextStopTimingText({ status: "late", minutes: 7, reference: "appointment", expectedMinute: 0 })).toBe(
      "En retard sur le RDV : environ 7\u00a0min",
    );
    expect(nextStopTimingText({ status: "early", minutes: 9, reference: "planned", expectedMinute: 0 })).toBe(
      "En avance sur le planning : environ 9\u00a0min",
    );
    expect(nextStopTimingText({ status: "late", minutes: 75, reference: "appointment", expectedMinute: 0 })).toBe(
      "En retard sur le RDV : environ 1\u00a0h\u00a015",
    );
    expect(nextStopTimingText({ status: "on_time", minutes: 0, reference: "planned", expectedMinute: 0 })).toBe("À l'heure");
    expect(nextStopTimingText({ status: "on_time", minutes: 0, reference: "appointment", expectedMinute: 0 })).toBe("À l'heure pour le RDV");
  });
});

describe("recordedLateness", () => {
  it("measures an outbound dropoff from the appointment, not from the planned time", () => {
    // Planned 07:15, appointment 07:30, dropped off 07:40: 10 min late for the appointment (not 25).
    expect(recordedLateness({ completedMinute: 460, plannedTapMinute: 435, appointmentMinute: 450 })).toEqual({ minutes: 10, reference: "appointment" });
    expect(recordedLateness({ completedMinute: 460, plannedTapMinute: 435, appointmentMinute: null })).toEqual({ minutes: 25, reference: "planned" });
  });

  it("dates a pickup at its planned departure (patient on board), a dropoff and an absence at the planned start", () => {
    const stop = { startMinute: 480, departureMinute: 495 };
    expect(plannedTapMinute({ ...stop, kind: "PICKUP", noShow: false })).toBe(495);
    expect(plannedTapMinute({ ...stop, kind: "PICKUP", noShow: true })).toBe(480);
    expect(plannedTapMinute({ ...stop, kind: "DROPOFF", noShow: false })).toBe(480);
    // An ambulance pickup with 15 min of service, tapped on time at 08:15: not late.
    const tap = plannedTapMinute({ ...stop, kind: "PICKUP", noShow: false });
    expect(recordedLateness({ completedMinute: 495, plannedTapMinute: tap, appointmentMinute: null })).toEqual({ minutes: 0, reference: "planned" });
  });

  it("shows any delay after an appointment, and 5 min or more either way on the planned time", () => {
    expect(latenessShown({ minutes: 1, reference: "appointment" })).toBe(true);
    expect(latenessShown({ minutes: -15, reference: "appointment" })).toBe(false);
    expect(latenessShown({ minutes: 4, reference: "planned" })).toBe(false);
    expect(latenessShown({ minutes: -5, reference: "planned" })).toBe(true);
    expect(latenessShown(null)).toBe(false);
  });
});
