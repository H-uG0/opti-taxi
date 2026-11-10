import { describe, expect, it } from "vitest";
import {
  appointmentMark,
  assignLanes,
  axisTicks,
  clickTargets,
  freeSlots,
  initials,
  minutesForPx,
  routeBlocks,
  tickLabel,
  unassignedWindow,
  zoomFactor,
  zoomIn,
  type TripBlock,
} from "./timeline-layout";

const RANGE = { start: 360, end: 1200 };

type Kind = "PICKUP" | "DROPOFF";
const stop = (sequence: number, tripId: string, kind: Kind, arrival: number, start: number, loadAfter: number) => ({
  sequence,
  tripId,
  kind,
  arrivalMinute: arrival,
  startMinute: start,
  departureMinute: start + 5,
  loadAfter,
});

describe("zoom", () => {
  it("widens the track so that 4\u00a0h or 2\u00a0h fill the visible part, never narrower than the day", () => {
    expect(zoomFactor(RANGE, "day")).toBe(1);
    expect(zoomFactor(RANGE, "4h")).toBe(3.5);
    expect(zoomFactor(RANGE, "2h")).toBe(7);
    expect(zoomFactor({ start: 600, end: 720 }, "4h")).toBe(1);
    expect(zoomIn("day")).toBe("4h");
    expect(zoomIn("4h")).toBe("2h");
    expect(zoomIn("2h")).toBeNull();
  });

  it("labels the axis every 2\u00a0h for a long day, every hour at 4\u00a0h, every half hour at 2\u00a0h", () => {
    expect(axisTicks({ start: 300, end: 1260 }, "day").map((t) => t.minute)).toEqual([360, 480, 600, 720, 840, 960, 1080, 1200]);
    expect(axisTicks({ start: 360, end: 1080 }, "day")).toHaveLength(13);
    expect(axisTicks(RANGE, "4h")).toHaveLength(15);
    expect(axisTicks({ start: 420, end: 540 }, "2h").map((t) => t.label)).toEqual(["7\u00a0h", "7\u00a0h\u00a030", "8\u00a0h", "8\u00a0h\u00a030", "9\u00a0h"]);
    expect(tickLabel(1470)).toBe("0\u00a0h\u00a030");
    // Labels that would touch on a narrow track: every 2 h, then 3 h.
    expect(axisTicks({ start: 360, end: 1140 }, "day", 0.6).map((t) => t.minute)).toEqual([360, 480, 600, 720, 840, 960, 1080]);
    expect(axisTicks({ start: 360, end: 1140 }, "day", 0.3).map((t) => t.label)).toEqual(["6\u00a0h", "9\u00a0h", "12\u00a0h", "15\u00a0h", "18\u00a0h"]);
    expect(axisTicks({ start: 420, end: 540 }, "2h", 1).map((t) => t.minute)).toEqual([420, 480, 540]);
  });

  it("converts pixels into minutes of the track", () => {
    expect(minutesForPx(24, 840, RANGE)).toBe(24);
    expect(minutesForPx(24, 3360, RANGE)).toBe(6);
    expect(minutesForPx(24, 0, RANGE)).toBe(840);
  });
});

describe("trip blocks", () => {
  it("draws each trip from its pick-up to its drop-off, trips on board together in two lanes", () => {
    const { blocks, lanes } = routeBlocks([
      stop(1, "a", "PICKUP", 410, 410, 1),
      stop(2, "b", "PICKUP", 420, 420, 2),
      stop(3, "a", "DROPOFF", 440, 440, 1),
      stop(4, "b", "DROPOFF", 441, 441, 0),
      stop(5, "c", "PICKUP", 470, 480, 1),
      stop(6, "c", "DROPOFF", 510, 510, 0),
    ]);
    expect(lanes).toBe(2);
    expect(blocks).toEqual([
      { tripId: "a", from: 410, to: 440, lane: 0 },
      { tripId: "b", from: 420, to: 441, lane: 1 },
      { tripId: "c", from: 480, to: 510, lane: 0 },
    ]);
  });

  it("keeps one lane for trips one after the other, and a short block for a trip with one stop", () => {
    expect(assignLanes([{ from: 0, to: 10 }, { from: 10, to: 20 }]).count).toBe(1);
    expect(assignLanes([]).count).toBe(1);
    const { blocks } = routeBlocks([stop(1, "a", "DROPOFF", 600, 600, 0)]);
    expect(blocks).toEqual([{ tripId: "a", from: 595, to: 600, lane: 0 }]);
  });
});

describe("click targets", () => {
  const block = (tripId: string, from: number, to: number, lane = 0): TripBlock => ({ tripId, from, to, lane });

  it("gives each block a target centred on it, at least the minimum width", () => {
    expect(clickTargets([block("a", 600, 610), block("b", 700, 760)], 30, RANGE, false)).toEqual([
      { tripIds: ["a"], from: 590, to: 620, lane: null },
      { tripIds: ["b"], from: 700, to: 760, lane: null },
    ]);
  });

  it("merges targets that would overlap into one listing their trips in time order («\u202f+3\u202f»)", () => {
    const targets = clickTargets([block("c", 630, 640), block("a", 600, 610), block("b", 612, 618)], 30, RANGE, false);
    expect(targets).toEqual([{ tripIds: ["a", "b", "c"], from: 590, to: 650, lane: null }]);
  });

  it("keeps the lanes of shared trips apart when asked, and merges them otherwise", () => {
    const shared = [block("a", 410, 440, 0), block("b", 420, 441, 1)];
    expect(clickTargets(shared, 24, RANGE, true).map((t) => [t.tripIds, t.lane])).toEqual([
      [["a"], 0],
      [["b"], 1],
    ]);
    expect(clickTargets(shared, 24, RANGE, false).map((t) => t.tripIds)).toEqual([["a", "b"]]);
  });

  it("keeps a target inside the range at both ends", () => {
    expect(clickTargets([block("a", 360, 362), block("b", 1198, 1200)], 20, RANGE, false)).toEqual([
      { tripIds: ["a"], from: 360, to: 380, lane: null },
      { tripIds: ["b"], from: 1180, to: 1200, lane: null },
    ]);
  });

  it("splits a chain of trips minutes apart into several «\u202f+N\u202f», touching, never one for hours", () => {
    // The whole day at 1 440 px: 24 px ≈ 41 min; ten 20-minute trips, one every 30 min from 06:52.
    const chain = Array.from({ length: 10 }, (_, i) => block(`t${i}`, 412 + 30 * i, 432 + 30 * i));
    const targets = clickTargets(chain, 41, RANGE, false);
    expect(targets.length).toBeGreaterThan(2);
    // Each trip in one target, in time order; no target over 3 widths; neighbours touch, never overlap.
    expect(targets.flatMap((t) => t.tripIds)).toEqual(chain.map((b) => b.tripId));
    for (const t of targets) {
      expect(t.to - t.from).toBeGreaterThanOrEqual(41);
      expect(t.to - t.from).toBeLessThanOrEqual(3 * 41);
    }
    for (let i = 1; i < targets.length; i++) expect(targets[i]!.from).toBeGreaterThanOrEqual(targets[i - 1]!.to);
    expect(targets[1]!.from).toBe(targets[0]!.to);
  });

  it("keeps a long trip and the short ones under it in one target (its target is never cut)", () => {
    // Two hours on board in one lane, short trips in the other, merged (compact density).
    const long = [block("long", 600, 720, 0), block("s1", 610, 620, 1), block("s2", 650, 660, 1), block("s3", 700, 710, 1)];
    expect(clickTargets(long, 41, RANGE, false).map((t) => t.tripIds)).toEqual([["long", "s1", "s2", "s3"]]);
  });
});

describe("free slots", () => {
  const route = {
    startMinute: 400,
    endMinute: 700,
    breakStartMinute: null as number | null,
    breakEndMinute: null as number | null,
    stops: [
      stop(1, "a", "PICKUP", 420, 420, 1),
      stop(2, "a", "DROPOFF", 450, 450, 0),
      // Arrived at 470 for a pick-up at 540: free from 470 to 540.
      stop(3, "b", "PICKUP", 470, 540, 1),
      // A wait with a patient on board is not free.
      stop(4, "c", "PICKUP", 560, 600, 2),
      stop(5, "b", "DROPOFF", 620, 620, 1),
      stop(6, "c", "DROPOFF", 640, 640, 0),
    ],
  };

  it("finds the gaps of 30\u00a0min or more: before and after the route in the shift, and the empty waits", () => {
    expect(freeSlots({ start: 360, end: 1020 }, route)).toEqual([
      { start: 360, end: 400 },
      { start: 470, end: 540 },
      { start: 700, end: 1020 },
    ]);
  });

  it("takes the break out of a gap, and drops what is left under 30\u00a0min", () => {
    expect(freeSlots({ start: 380, end: 1020 }, { ...route, breakStartMinute: 480, breakEndMinute: 525 })).toEqual([
      { start: 700, end: 1020 },
    ]);
    expect(freeSlots({ start: 360, end: 1020 }, { ...route, breakStartMinute: 700, breakEndMinute: 745 })).toEqual([
      { start: 360, end: 400 },
      { start: 470, end: 540 },
      { start: 745, end: 1020 },
    ]);
  });

  it("draws no slot for a vehicle without a route", () => {
    expect(freeSlots({ start: 360, end: 1020 }, null)).toEqual([]);
  });
});

describe("trip times", () => {
  const outbound = {
    direction: "OUTBOUND" as const,
    appointmentMinute: 510,
    readyMinute: null,
    plannedPickupMinute: 470,
    plannedDropoffMinute: 500,
  };
  const ret = { ...outbound, direction: "RETURN" as const, appointmentMinute: null, readyMinute: 660, plannedPickupMinute: 675 };
  const waits = { beforeAppointmentMin: 30, afterSessionMin: 15 };

  it("places a trip without a vehicle on its drop-off window (outbound) or pick-up window (return)", () => {
    expect(unassignedWindow(outbound, waits)).toEqual({ start: 480, end: 510, anchor: 510 });
    expect(unassignedWindow(ret, waits)).toEqual({ start: 660, end: 675, anchor: 660 });
    expect(unassignedWindow(ret, { beforeAppointmentMin: 0, afterSessionMin: 0 })).toEqual({ start: 660, end: 670, anchor: 660 });
    expect(unassignedWindow({ ...outbound, appointmentMinute: null }, waits)).toBeNull();
  });

  it("flags an appointment reached less than 5 minutes ahead", () => {
    expect(appointmentMark(outbound)).toEqual({ kind: "appointment", minute: 510, marginMin: 10, tight: false });
    expect(appointmentMark({ ...outbound, plannedDropoffMinute: 507 })?.tight).toBe(true);
    expect(appointmentMark({ ...outbound, plannedDropoffMinute: 505 })?.tight).toBe(false);
    expect(appointmentMark({ ...outbound, plannedDropoffMinute: 515 })).toMatchObject({ marginMin: -5, tight: true });
    expect(appointmentMark({ ...outbound, plannedDropoffMinute: null })).toMatchObject({ marginMin: null, tight: false });
    expect(appointmentMark(ret)).toEqual({ kind: "ready", minute: 660, marginMin: 15, tight: false });
  });

  it("writes the patient's initials", () => {
    expect(initials("Monique Aubert")).toBe("MA");
    expect(initials("Élodie Fabre")).toBe("ÉF");
    expect(initials("  Jean-Pierre  de la Turc ")).toBe("JT");
    expect(initials("Cher")).toBe("C");
    expect(initials("")).toBe("");
  });
});
