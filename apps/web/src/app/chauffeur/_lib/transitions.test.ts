import { describe, expect, it } from "vitest";
import type { StopKind, TripStatus } from "@prisma/client";
import {
  decideStopAction,
  isArrivalAction,
  NO_CONTROLS,
  STOP_AUDIT_ACTIONS,
  stopAuditAction,
  stopControls,
  stopWrite,
  type StopAction,
  type StopSnapshot,
} from "./transitions";

const NOW = new Date("2026-11-02T08:15:00Z");
const EARLIER = new Date("2026-11-02T07:50:00Z");

function snapshot(kind: StopKind, tripStatus: TripStatus, completedAt: Date | null = null, isLatestCompleted = false): StopSnapshot {
  return { kind, tripStatus, completedAt, isLatestCompleted };
}

describe("decideStopAction: pickup", () => {
  it("records the pickup now and puts the patient on board", () => {
    expect(decideStopAction("PICKUP", snapshot("PICKUP", "ASSIGNED"), NOW)).toMatchObject({
      type: "apply",
      completedAt: NOW,
      tripStatus: "PICKED_UP",
    });
  });

  it("is idempotent", () => {
    expect(decideStopAction("PICKUP", snapshot("PICKUP", "PICKED_UP", EARLIER), NOW).type).toBe("noop");
    expect(decideStopAction("PICKUP", snapshot("PICKUP", "DROPPED_OFF", EARLIER), NOW).type).toBe("noop");
  });

  it("fills a missing time without changing a later status", () => {
    expect(decideStopAction("PICKUP", snapshot("PICKUP", "DROPPED_OFF"), NOW)).toMatchObject({
      type: "apply",
      completedAt: NOW,
      tripStatus: "DROPPED_OFF",
    });
  });

  it("refuses a dropoff stop, an absent patient and a cancelled trip", () => {
    expect(decideStopAction("PICKUP", snapshot("DROPOFF", "ASSIGNED"), NOW)).toMatchObject({ type: "refuse", reason: "WRONG_KIND" });
    expect(decideStopAction("PICKUP", snapshot("PICKUP", "NO_SHOW", EARLIER), NOW)).toMatchObject({ type: "refuse", reason: "NO_SHOW" });
    expect(decideStopAction("PICKUP", snapshot("PICKUP", "CANCELLED"), NOW)).toMatchObject({ type: "refuse", reason: "CANCELLED" });
  });
});

describe("decideStopAction: dropoff", () => {
  it("requires the pickup first", () => {
    expect(decideStopAction("DROPOFF", snapshot("DROPOFF", "ASSIGNED"), NOW)).toMatchObject({
      type: "refuse",
      reason: "NOT_PICKED_UP",
    });
    expect(decideStopAction("DROPOFF", snapshot("DROPOFF", "PLANNED"), NOW)).toMatchObject({ type: "refuse", reason: "NOT_PICKED_UP" });
  });

  it("records the dropoff of a patient on board", () => {
    expect(decideStopAction("DROPOFF", snapshot("DROPOFF", "PICKED_UP"), NOW)).toMatchObject({
      type: "apply",
      completedAt: NOW,
      tripStatus: "DROPPED_OFF",
    });
  });

  it("is idempotent and refuses absent or cancelled trips", () => {
    expect(decideStopAction("DROPOFF", snapshot("DROPOFF", "DROPPED_OFF", EARLIER), NOW).type).toBe("noop");
    expect(decideStopAction("DROPOFF", snapshot("DROPOFF", "NO_SHOW"), NOW)).toMatchObject({ type: "refuse", reason: "NO_SHOW" });
    expect(decideStopAction("DROPOFF", snapshot("DROPOFF", "CANCELLED"), NOW)).toMatchObject({ type: "refuse", reason: "CANCELLED" });
    expect(decideStopAction("DROPOFF", snapshot("PICKUP", "PICKED_UP"), NOW)).toMatchObject({ type: "refuse", reason: "WRONG_KIND" });
  });
});

describe("decideStopAction: patient absent", () => {
  it("completes the pickup now and marks the trip NO_SHOW", () => {
    expect(decideStopAction("NO_SHOW", snapshot("PICKUP", "ASSIGNED"), NOW)).toMatchObject({
      type: "apply",
      completedAt: NOW,
      tripStatus: "NO_SHOW",
    });
  });

  it("is idempotent", () => {
    expect(decideStopAction("NO_SHOW", snapshot("PICKUP", "NO_SHOW", EARLIER), NOW).type).toBe("noop");
  });

  it("refuses once the patient is on board, on a dropoff and on a cancelled trip", () => {
    expect(decideStopAction("NO_SHOW", snapshot("PICKUP", "PICKED_UP", EARLIER), NOW)).toMatchObject({
      type: "refuse",
      reason: "ALREADY_PICKED_UP",
    });
    expect(decideStopAction("NO_SHOW", snapshot("DROPOFF", "ASSIGNED"), NOW)).toMatchObject({ type: "refuse", reason: "WRONG_KIND" });
    expect(decideStopAction("NO_SHOW", snapshot("PICKUP", "CANCELLED"), NOW)).toMatchObject({ type: "refuse", reason: "CANCELLED" });
  });
});

describe("decideStopAction: undo", () => {
  it("goes back one step", () => {
    expect(decideStopAction("UNDO", snapshot("PICKUP", "PICKED_UP", EARLIER, true), NOW)).toMatchObject({
      type: "apply",
      completedAt: null,
      tripStatus: "ASSIGNED",
    });
    expect(decideStopAction("UNDO", snapshot("PICKUP", "NO_SHOW", EARLIER, true), NOW)).toMatchObject({
      type: "apply",
      completedAt: null,
      tripStatus: "ASSIGNED",
    });
    expect(decideStopAction("UNDO", snapshot("DROPOFF", "DROPPED_OFF", EARLIER, true), NOW)).toMatchObject({
      type: "apply",
      completedAt: null,
      tripStatus: "PICKED_UP",
    });
  });

  it("only undoes the latest status of the route", () => {
    expect(decideStopAction("UNDO", snapshot("PICKUP", "PICKED_UP", EARLIER, false), NOW)).toMatchObject({
      type: "refuse",
      reason: "NOT_LATEST",
    });
  });

  it("refuses to undo a pickup whose dropoff is recorded", () => {
    expect(decideStopAction("UNDO", snapshot("PICKUP", "DROPPED_OFF", EARLIER, true), NOW)).toMatchObject({
      type: "refuse",
      reason: "UNDO_DROPOFF_FIRST",
    });
  });

  it("is idempotent: a replay finds nothing to undo", () => {
    expect(decideStopAction("UNDO", snapshot("PICKUP", "ASSIGNED", null, false), NOW).type).toBe("noop");
  });

  it("does not touch a trip cancelled by the regulator", () => {
    expect(decideStopAction("UNDO", snapshot("PICKUP", "CANCELLED", EARLIER, true), NOW)).toMatchObject({
      type: "refuse",
      reason: "CANCELLED",
    });
  });
});

describe("stopWrite", () => {
  const USER = "user_1";
  const RECEIVED = new Date("2026-11-03T08:25:00Z");
  const applied = (action: StopAction, stop: StopSnapshot) => {
    const decision = decideStopAction(action, stop, NOW);
    if (decision.type !== "apply") throw new Error(`${action} should apply`);
    return stopWrite(decision, USER, RECEIVED);
  };

  it("records who set the status with the time of the gesture and the time it reached the server", () => {
    const recorded = { completedAt: NOW, completedById: USER, completedReceivedAt: RECEIVED, completedSource: null, correctionReason: null };
    expect(applied("PICKUP", snapshot("PICKUP", "ASSIGNED"))).toEqual(recorded);
    expect(applied("DROPOFF", snapshot("DROPOFF", "PICKED_UP"))).toEqual(recorded);
    expect(applied("NO_SHOW", snapshot("PICKUP", "ASSIGNED"))).toEqual(recorded);
  });

  it("clears the author and both times on undo", () => {
    const cleared = { completedAt: null, completedById: null, completedReceivedAt: null, completedSource: null, correctionReason: null };
    expect(applied("UNDO", snapshot("PICKUP", "PICKED_UP", EARLIER, true))).toEqual(cleared);
    expect(applied("UNDO", snapshot("DROPOFF", "DROPPED_OFF", EARLIER, true))).toEqual(cleared);
  });

  it("says a status was typed afterwards in « Fin de tournée » (FLD-02)", () => {
    const decision = decideStopAction("DROPOFF", snapshot("DROPOFF", "PICKED_UP"), NOW);
    if (decision.type !== "apply") throw new Error("should apply");
    expect(stopWrite(decision, USER, RECEIVED, "DECLARED")).toMatchObject({ completedAt: NOW, completedSource: "DECLARED" });
  });
});

describe("STOP_AUDIT_ACTIONS / stopAuditAction", () => {
  it("names one audit action per status action (an undo depends on the stop kind)", () => {
    expect(STOP_AUDIT_ACTIONS).toEqual({
      PICKUP: "stop.pickup",
      DROPOFF: "stop.dropoff",
      NO_SHOW: "stop.no_show",
      ARRIVE: "stop.arrive",
      UNDO_ARRIVE: "stop.undo_arrive",
    });
  });

  it("names the stop kind an undo reverts", () => {
    expect(stopAuditAction("PICKUP", "PICKUP")).toBe("stop.pickup");
    expect(stopAuditAction("NO_SHOW", "PICKUP")).toBe("stop.no_show");
    expect(stopAuditAction("DROPOFF", "DROPOFF")).toBe("stop.dropoff");
    expect(stopAuditAction("UNDO", "PICKUP")).toBe("stop.undo_pickup");
    expect(stopAuditAction("UNDO", "DROPOFF")).toBe("stop.undo_dropoff");
  });
});

describe("decideStopAction: arrival (FLD-01)", () => {
  const arrived = (tripStatus: TripStatus = "ASSIGNED", completedAt: Date | null = null): StopSnapshot => ({
    ...snapshot("PICKUP", tripStatus, completedAt),
    arrivedAt: EARLIER,
  });

  it("dates the arrival at a pickup still to do, and nothing else", () => {
    expect(decideStopAction("ARRIVE", snapshot("PICKUP", "ASSIGNED"), NOW)).toEqual({
      type: "apply",
      completedAt: null,
      tripStatus: "ASSIGNED",
      arrivedAt: NOW,
      message: "Arrivée enregistrée.",
    });
    expect(isArrivalAction("ARRIVE")).toBe(true);
    expect(isArrivalAction("PICKUP")).toBe(false);
  });

  it("is idempotent and changes nothing once the patient is on board", () => {
    expect(decideStopAction("ARRIVE", arrived(), NOW).type).toBe("noop");
    expect(decideStopAction("ARRIVE", snapshot("PICKUP", "PICKED_UP", EARLIER), NOW)).toMatchObject({ type: "noop", message: "Prise en charge déjà enregistrée." });
  });

  it("is refused on a drop-off, a cancelled trip and an absent patient", () => {
    expect(decideStopAction("ARRIVE", snapshot("DROPOFF", "PICKED_UP"), NOW)).toMatchObject({ type: "refuse", reason: "WRONG_KIND" });
    expect(decideStopAction("ARRIVE", snapshot("PICKUP", "CANCELLED"), NOW)).toMatchObject({ type: "refuse", reason: "CANCELLED" });
    expect(decideStopAction("ARRIVE", snapshot("PICKUP", "NO_SHOW", EARLIER), NOW)).toMatchObject({ type: "refuse", reason: "NO_SHOW" });
  });

  it("undoes an arrival while the pickup is still to do, once (a replay changes nothing)", () => {
    expect(decideStopAction("UNDO_ARRIVE", arrived(), NOW)).toMatchObject({ type: "apply", arrivedAt: null, completedAt: null, tripStatus: "ASSIGNED" });
    expect(decideStopAction("UNDO_ARRIVE", snapshot("PICKUP", "ASSIGNED"), NOW).type).toBe("noop");
    expect(decideStopAction("UNDO_ARRIVE", arrived("PICKED_UP", NOW), NOW)).toMatchObject({ type: "refuse", reason: "ALREADY_RECORDED" });
    expect(decideStopAction("UNDO_ARRIVE", arrived("NO_SHOW", NOW), NOW)).toMatchObject({ type: "refuse", reason: "ALREADY_RECORDED" });
  });

  it("leaves the arrival untouched by the other statuses", () => {
    const pickup = decideStopAction("PICKUP", arrived(), NOW);
    expect(pickup).toMatchObject({ type: "apply", completedAt: NOW, tripStatus: "PICKED_UP" });
    expect(pickup).not.toHaveProperty("arrivedAt");
  });
});

describe("stopControls", () => {
  it("shows nothing outside the service day", () => {
    expect(stopControls(snapshot("PICKUP", "ASSIGNED"), false)).toEqual(NO_CONTROLS);
  });

  it("offers pickup and absence on a pending pickup", () => {
    expect(stopControls(snapshot("PICKUP", "ASSIGNED"), true)).toEqual({
      primary: "PICKUP",
      blockedReason: null,
      noShow: true,
      undo: false,
      arrive: true,
      undoArrive: false,
    });
    // Arrived: « Annuler l'arrivée » instead of « Arrivé », the rest unchanged.
    expect(stopControls({ ...snapshot("PICKUP", "ASSIGNED"), arrivedAt: EARLIER }, true)).toMatchObject({ arrive: false, undoArrive: true, primary: "PICKUP", noShow: true });
  });

  it("blocks the dropoff until the pickup is recorded", () => {
    expect(stopControls(snapshot("DROPOFF", "ASSIGNED"), true)).toEqual({
      ...NO_CONTROLS,
      primary: "DROPOFF",
      blockedReason: "Prise en charge non saisie\u00a0: enregistrez-la d'abord.",
    });
    expect(stopControls(snapshot("DROPOFF", "PICKED_UP"), true)).toEqual({ ...NO_CONTROLS, primary: "DROPOFF" });
  });

  it("offers undo only on the latest recorded status", () => {
    expect(stopControls(snapshot("PICKUP", "PICKED_UP", EARLIER, true), true).undo).toBe(true);
    expect(stopControls(snapshot("PICKUP", "PICKED_UP", EARLIER, false), true).undo).toBe(false);
    expect(stopControls(snapshot("PICKUP", "NO_SHOW", EARLIER, true), true).undo).toBe(true);
  });

  it("offers nothing on skipped and cancelled stops", () => {
    expect(stopControls(snapshot("DROPOFF", "NO_SHOW"), true)).toEqual(NO_CONTROLS);
    expect(stopControls(snapshot("PICKUP", "CANCELLED"), true)).toEqual(NO_CONTROLS);
  });

  it("never shows a usable button that the server would refuse", () => {
    const kinds: StopKind[] = ["PICKUP", "DROPOFF"];
    const statuses: TripStatus[] = ["PLANNED", "ASSIGNED", "PICKED_UP", "DROPPED_OFF", "CANCELLED", "NO_SHOW"];
    for (const kind of kinds) {
      for (const tripStatus of statuses) {
        for (const completedAt of [null, EARLIER]) {
          for (const isLatestCompleted of [false, true]) {
            const stop = snapshot(kind, tripStatus, completedAt, isLatestCompleted);
            const controls = stopControls(stop, true);
            const shown: StopAction[] = [];
            if (controls.primary && !controls.blockedReason) shown.push(controls.primary);
            if (controls.noShow) shown.push("NO_SHOW");
            if (controls.undo) shown.push("UNDO");
            for (const action of shown) {
              expect(decideStopAction(action, stop, NOW).type, `${action} on ${kind}/${tripStatus}/${String(completedAt)}`).toBe("apply");
            }
          }
        }
      }
    }
  });
});
