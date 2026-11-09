import { describe, expect, it } from "vitest";
import { boundObservedAt, DEFERRED_AFTER_MS, MAX_STATUS_AGE_MS, previousStatusAt, type RecordedStop } from "./observed-time";

const RECEIVED = new Date("2026-11-03T07:25:00Z");
const MIN = 60_000;
const at = (ms: number) => RECEIVED.getTime() + ms;

describe("boundObservedAt", () => {
  it("records a status sent later from the queue at the time of the gesture", () => {
    // Tapped at 08:02 Paris (07:02Z) in a white zone, sent at 08:25 by a phone whose clock is right.
    const result = boundObservedAt({ observedAt: at(-23 * MIN), sentAt: at(0), receivedAt: RECEIVED, previousAt: null });
    expect(result).toEqual({ ok: true, at: new Date("2026-11-03T07:02:00Z"), deferred: true });
  });

  it("treats a status received within a minute of the gesture as sent live", () => {
    const result = boundObservedAt({ observedAt: at(-20_000), sentAt: at(-20_000), receivedAt: RECEIVED, previousAt: null });
    expect(result).toEqual({ ok: true, at: RECEIVED, deferred: false });
    expect(DEFERRED_AFTER_MS).toBe(MIN);
  });

  it("cancels the phone's clock offset with the time the request left it", () => {
    // The phone is 7 min slow: it says the gesture was at 07:55 and the request left at 08:18 (its clock).
    const result = boundObservedAt({ observedAt: at(-30 * MIN), sentAt: at(-7 * MIN), receivedAt: RECEIVED, previousAt: null });
    expect(result).toMatchObject({ ok: true, at: new Date(at(-23 * MIN)) });
    // 5 min fast: a gesture "in the future" by its clock is brought back where it belongs.
    const fast = boundObservedAt({ observedAt: at(5 * MIN - 10 * MIN), sentAt: at(5 * MIN), receivedAt: RECEIVED, previousAt: null });
    expect(fast).toMatchObject({ ok: true, at: new Date(at(-10 * MIN)) });
  });

  it("never records a status in the future", () => {
    const result = boundObservedAt({ observedAt: at(10 * MIN), sentAt: null, receivedAt: RECEIVED, previousAt: null });
    expect(result).toEqual({ ok: true, at: RECEIVED, deferred: false });
  });

  it("refuses a status more than 3 h old, accepts one just inside", () => {
    expect(MAX_STATUS_AGE_MS).toBe(3 * 60 * MIN);
    expect(boundObservedAt({ observedAt: at(-MAX_STATUS_AGE_MS - MIN), sentAt: at(0), receivedAt: RECEIVED, previousAt: null })).toEqual({
      ok: false,
      reason: "too-old",
    });
    expect(boundObservedAt({ observedAt: at(-MAX_STATUS_AGE_MS + MIN), sentAt: at(0), receivedAt: RECEIVED, previousAt: null })).toMatchObject({
      ok: true,
      deferred: true,
    });
    // The bound applies after the offset correction: a phone 4 h slow is not refused for it.
    expect(boundObservedAt({ observedAt: at(-4 * 60 * MIN - 2 * MIN), sentAt: at(-4 * 60 * MIN), receivedAt: RECEIVED, previousAt: null })).toEqual({
      ok: true,
      at: new Date(at(-2 * MIN)),
      deferred: true,
    });
  });

  it("never records a status before the one it follows (a dropoff before its pickup)", () => {
    const pickup = new Date(at(-12 * MIN));
    const result = boundObservedAt({ observedAt: at(-15 * MIN), sentAt: at(0), receivedAt: RECEIVED, previousAt: pickup });
    expect(result).toEqual({ ok: true, at: pickup, deferred: true });
    // After it: untouched.
    expect(boundObservedAt({ observedAt: at(-5 * MIN), sentAt: at(0), receivedAt: RECEIVED, previousAt: pickup })).toMatchObject({
      at: new Date(at(-5 * MIN)),
    });
  });

  it("uses the reception time when the phone sends no time (an older client)", () => {
    expect(boundObservedAt({ observedAt: null, sentAt: null, receivedAt: RECEIVED, previousAt: null })).toEqual({
      ok: true,
      at: RECEIVED,
      deferred: false,
    });
    expect(boundObservedAt({ observedAt: Number.NaN, sentAt: at(0), receivedAt: RECEIVED, previousAt: null })).toMatchObject({ at: RECEIVED });
  });
});

describe("previousStatusAt", () => {
  const stop = (
    id: string,
    sequence: number,
    kind: "PICKUP" | "DROPOFF",
    tripId: string,
    minutes: number | null,
    cancelled = false,
  ): RecordedStop => ({
    id,
    sequence,
    kind,
    tripId,
    completedAt: minutes === null ? null : new Date(at(minutes * MIN)),
    cancelled,
  });

  it("is the latest status recorded on an earlier stop of the route, or the trip's pickup for a dropoff", () => {
    const route = [
      stop("a_pick", 1, "PICKUP", "a", -40),
      stop("b_pick", 2, "PICKUP", "b", -25),
      stop("a_drop", 3, "DROPOFF", "a", null),
      stop("c_pick", 4, "PICKUP", "c", -5),
    ];
    // A pickup or an absence on stop 3 or later cannot go before b's pickup (08:00), whatever the phone says.
    expect(previousStatusAt(route[2]!, route)).toEqual(new Date(at(-25 * MIN)));
    expect(previousStatusAt({ id: "x", sequence: 5, kind: "PICKUP", tripId: "x" }, route)).toEqual(new Date(at(-5 * MIN)));
    // A later stop recorded meanwhile (crew mate) does not bound an earlier one; the first stop has nothing before it.
    expect(previousStatusAt(route[1]!, route)).toEqual(new Date(at(-40 * MIN)));
    expect(previousStatusAt(route[0]!, route)).toBeNull();
  });

  it("leaves out cancelled trips and the stop itself, never its own trip's pickup", () => {
    const route = [
      stop("a_pick", 1, "PICKUP", "a", -40),
      stop("z_pick", 2, "PICKUP", "z", -10, true),
      stop("a_drop", 3, "DROPOFF", "a", -30),
    ];
    expect(previousStatusAt(route[2]!, route)).toEqual(new Date(at(-40 * MIN)));
    // A dropoff placed before its pickup in a hand-made route still follows it.
    const swapped = [stop("a_drop", 1, "DROPOFF", "a", null), stop("a_pick", 2, "PICKUP", "a", -15)];
    expect(previousStatusAt(swapped[0]!, swapped)).toEqual(new Date(at(-15 * MIN)));
  });

  it("brings forward a status sent later that would go before a status already recorded", () => {
    // Pickup of stop 4 tapped offline at 08:00, sent at 08:25; stop 3 was recorded at 08:10 by the crew mate.
    const previousAt = new Date(at(-15 * MIN));
    expect(boundObservedAt({ observedAt: at(-25 * MIN), sentAt: at(0), receivedAt: RECEIVED, previousAt })).toEqual({
      ok: true,
      at: previousAt,
      deferred: true,
    });
  });
});
