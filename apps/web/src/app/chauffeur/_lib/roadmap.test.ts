import { describe, expect, it } from "vitest";
import type { StopKind, TripStatus } from "@prisma/client";
import * as domain from "@/lib/domain/no-show";
import {
  buildTimeline,
  coPassengers,
  isFacilityStop,
  isReadableRoadmapDate,
  isSameEpisode,
  latestCompletedStopId,
  nextStopId,
  displayName,
  returnTripsAfterOutboundNoShow,
  roadmapDateWindow,
  routeProgress,
  stopKeyTime,
  stopState,
  type StopLike,
} from "./roadmap";

function stop(
  sequence: number,
  tripId: string,
  kind: StopKind,
  options: { completedAt?: string | null; tripStatus?: TripStatus } = {},
): StopLike {
  return {
    id: `s${sequence}`,
    sequence,
    kind,
    tripId,
    completedAt: options.completedAt ? new Date(options.completedAt) : null,
    tripStatus: options.tripStatus ?? "ASSIGNED",
  };
}

describe("stopState", () => {
  it("is pending until the stop is recorded", () => {
    expect(stopState({ kind: "PICKUP", completedAt: null, tripStatus: "ASSIGNED" })).toBe("pending");
    expect(stopState({ kind: "PICKUP", completedAt: new Date(), tripStatus: "PICKED_UP" })).toBe("done");
    expect(stopState({ kind: "DROPOFF", completedAt: new Date(), tripStatus: "DROPPED_OFF" })).toBe("done");
  });

  it("marks the absent patient's pickup and skips the dropoff", () => {
    expect(stopState({ kind: "PICKUP", completedAt: new Date(), tripStatus: "NO_SHOW" })).toBe("no_show");
    expect(stopState({ kind: "DROPOFF", completedAt: null, tripStatus: "NO_SHOW" })).toBe("skipped");
  });

  it("shows trips cancelled by the regulator as cancelled", () => {
    expect(stopState({ kind: "PICKUP", completedAt: null, tripStatus: "CANCELLED" })).toBe("cancelled");
    expect(stopState({ kind: "DROPOFF", completedAt: null, tripStatus: "CANCELLED" })).toBe("cancelled");
  });
});

describe("nextStopId", () => {
  it("is the first pending stop in route order, whatever the input order", () => {
    const stops = [
      stop(2, "b", "PICKUP"),
      stop(0, "a", "PICKUP", { completedAt: "2026-11-02T07:00:00Z", tripStatus: "PICKED_UP" }),
      stop(1, "a", "DROPOFF"),
    ];
    expect(nextStopId(stops)).toBe("s1");
  });

  it("keeps a forgotten earlier stop as next", () => {
    const stops = [
      stop(0, "a", "PICKUP"),
      stop(1, "b", "PICKUP", { completedAt: "2026-11-02T07:10:00Z", tripStatus: "PICKED_UP" }),
      stop(2, "b", "DROPOFF"),
    ];
    expect(nextStopId(stops)).toBe("s0");
  });

  it("skips absent and cancelled patients", () => {
    const stops = [
      stop(0, "a", "PICKUP", { completedAt: "2026-11-02T07:00:00Z", tripStatus: "NO_SHOW" }),
      stop(1, "c", "PICKUP", { tripStatus: "CANCELLED" }),
      stop(2, "a", "DROPOFF", { tripStatus: "NO_SHOW" }),
      stop(3, "b", "PICKUP"),
    ];
    expect(nextStopId(stops)).toBe("s3");
  });

  it("is null when the route is finished or empty", () => {
    expect(nextStopId([])).toBeNull();
    expect(
      nextStopId([
        stop(0, "a", "PICKUP", { completedAt: "2026-11-02T07:00:00Z", tripStatus: "DROPPED_OFF" }),
        stop(1, "a", "DROPOFF", { completedAt: "2026-11-02T07:30:00Z", tripStatus: "DROPPED_OFF" }),
      ]),
    ).toBeNull();
  });
});

describe("latestCompletedStopId", () => {
  it("picks the most recent completedAt, not the highest sequence", () => {
    const stops = [
      stop(0, "a", "PICKUP", { completedAt: "2026-11-02T07:20:00Z", tripStatus: "PICKED_UP" }),
      stop(1, "b", "PICKUP", { completedAt: "2026-11-02T07:05:00Z", tripStatus: "PICKED_UP" }),
      stop(2, "a", "DROPOFF"),
    ];
    expect(latestCompletedStopId(stops)).toBe("s0");
  });

  it("breaks ties with the route order", () => {
    const stops = [
      stop(3, "b", "PICKUP", { completedAt: "2026-11-02T07:05:00Z", tripStatus: "PICKED_UP" }),
      stop(4, "a", "PICKUP", { completedAt: "2026-11-02T07:05:00Z", tripStatus: "PICKED_UP" }),
    ];
    expect(latestCompletedStopId(stops)).toBe("s4");
  });

  it("ignores cancelled trips and is null without any status", () => {
    expect(latestCompletedStopId([stop(0, "a", "PICKUP")])).toBeNull();
    expect(
      latestCompletedStopId([
        stop(0, "a", "PICKUP", { completedAt: "2026-11-02T07:00:00Z", tripStatus: "PICKED_UP" }),
        stop(1, "b", "PICKUP", { completedAt: "2026-11-02T08:00:00Z", tripStatus: "CANCELLED" }),
      ]),
    ).toBe("s0");
  });
});

describe("coPassengers", () => {
  it("finds patients on board at the same time", () => {
    // a picked up, b picked up, a dropped, b dropped: shared. c rides alone afterwards.
    const stops = [
      stop(0, "a", "PICKUP"),
      stop(1, "b", "PICKUP"),
      stop(2, "a", "DROPOFF"),
      stop(3, "b", "DROPOFF"),
      stop(4, "c", "PICKUP"),
      stop(5, "c", "DROPOFF"),
    ];
    const result = coPassengers(stops);
    expect(result.get("a")).toEqual(["b"]);
    expect(result.get("b")).toEqual(["a"]);
    expect(result.get("c")).toEqual([]);
  });

  it("does not share a ride that ends where the next one starts", () => {
    const result = coPassengers([stop(0, "a", "PICKUP"), stop(1, "a", "DROPOFF"), stop(2, "b", "PICKUP"), stop(3, "b", "DROPOFF")]);
    expect(result.get("a")).toEqual([]);
    expect(result.get("b")).toEqual([]);
  });

  it("handles a ride nested in another one and lists co-passengers in pickup order", () => {
    const result = coPassengers([
      stop(0, "a", "PICKUP"),
      stop(1, "b", "PICKUP"),
      stop(2, "b", "DROPOFF"),
      stop(3, "c", "PICKUP"),
      stop(4, "c", "DROPOFF"),
      stop(5, "a", "DROPOFF"),
    ]);
    expect(result.get("a")).toEqual(["b", "c"]);
    expect(result.get("b")).toEqual(["a"]);
    expect(result.get("c")).toEqual(["a"]);
  });

  it("leaves absent and cancelled patients out", () => {
    const result = coPassengers([
      stop(0, "a", "PICKUP", { tripStatus: "NO_SHOW", completedAt: "2026-11-02T07:00:00Z" }),
      stop(1, "b", "PICKUP"),
      stop(2, "a", "DROPOFF", { tripStatus: "NO_SHOW" }),
      stop(3, "b", "DROPOFF"),
    ]);
    expect(result.has("a")).toBe(false);
    expect(result.get("b")).toEqual([]);
  });
});

describe("stop details", () => {
  it("knows which end of the trip is the facility", () => {
    expect(isFacilityStop("DROPOFF", "OUTBOUND")).toBe(true);
    expect(isFacilityStop("PICKUP", "OUTBOUND")).toBe(false);
    expect(isFacilityStop("PICKUP", "RETURN")).toBe(true);
    expect(isFacilityStop("DROPOFF", "RETURN")).toBe(false);
  });

  it("shows the appointment on an outbound dropoff and the end of session on a return pickup", () => {
    expect(stopKeyTime({ kind: "DROPOFF", direction: "OUTBOUND", appointmentMinute: 450, readyMinute: null })).toEqual({
      label: "RDV",
      minute: 450,
    });
    expect(stopKeyTime({ kind: "PICKUP", direction: "OUTBOUND", appointmentMinute: 450, readyMinute: null })).toBeNull();
    expect(stopKeyTime({ kind: "PICKUP", direction: "RETURN", appointmentMinute: null, readyMinute: 690 })).toEqual({
      label: "Fin de séance",
      minute: 690,
    });
    expect(stopKeyTime({ kind: "DROPOFF", direction: "RETURN", appointmentMinute: null, readyMinute: 690 })).toBeNull();
  });

  it("formats patient names with the family name in capitals", () => {
    expect(displayName({ firstName: "Jeanne", lastName: "Martin-Lefèvre" })).toBe("Jeanne MARTIN-LEFÈVRE");
  });

  it("counts closed stops", () => {
    expect(
      routeProgress([
        stop(0, "a", "PICKUP", { completedAt: "2026-11-02T07:00:00Z", tripStatus: "NO_SHOW" }),
        stop(1, "a", "DROPOFF", { tripStatus: "NO_SHOW" }),
        stop(2, "b", "PICKUP"),
      ]),
    ).toEqual({ closed: 2, total: 3 });
  });
});

describe("readable roadmap dates", () => {
  const today = "2026-11-02";

  it("opens today and tomorrow only", () => {
    expect(roadmapDateWindow(today)).toEqual({ first: "2026-11-02", last: "2026-11-03" });
    expect(isReadableRoadmapDate("2026-11-02", today)).toBe(true);
    expect(isReadableRoadmapDate("2026-11-03", today)).toBe(true);
  });

  it("refuses past and later days (patient data minimisation)", () => {
    expect(isReadableRoadmapDate("2026-11-01", today)).toBe(false);
    expect(isReadableRoadmapDate("2025-01-15", today)).toBe(false);
    expect(isReadableRoadmapDate("2026-11-04", today)).toBe(false);
  });

  it("refuses anything that is not a calendar date", () => {
    expect(isReadableRoadmapDate(null, today)).toBe(false);
    expect(isReadableRoadmapDate("", today)).toBe(false);
    expect(isReadableRoadmapDate("2026-11-3", today)).toBe(false);
    expect(isReadableRoadmapDate("2026-02-30", today)).toBe(false);
  });

  it("crosses month and year ends", () => {
    expect(isReadableRoadmapDate("2027-01-01", "2026-12-31")).toBe(true);
  });
});

describe("outbound no-show on the return leg", () => {
  // The rules are tested in @/lib/domain/no-show; the driver screens keep importing them from here.
  it("re-exports the shared pairing helpers", () => {
    expect(isSameEpisode).toBe(domain.isSameEpisode);
    expect(returnTripsAfterOutboundNoShow).toBe(domain.returnTripsAfterOutboundNoShow);
  });
});

describe("buildTimeline", () => {
  const stops = [
    { sequence: 1, startMinute: 600, id: "b" },
    { sequence: 0, startMinute: 480, id: "a" },
    { sequence: 2, startMinute: 780, id: "c" },
  ];

  it("frames the stops with the depot and puts the break before the first stop after it", () => {
    const items = buildTimeline(stops, { startMinute: 450, endMinute: 840, breakStartMinute: 720, breakEndMinute: 765 });
    expect(items.map((item) => (item.type === "stop" ? item.stop.id : item.type))).toEqual([
      "depart",
      "a",
      "b",
      "break",
      "c",
      "return",
    ]);
    expect(items[0]).toEqual({ type: "depart", minute: 450 });
    expect(items[3]).toEqual({ type: "break", startMinute: 720, endMinute: 765 });
    expect(items.at(-1)).toEqual({ type: "return", minute: 840 });
  });

  it("puts a late break after the last stop and omits a missing one", () => {
    const late = buildTimeline(stops, { startMinute: 450, endMinute: 900, breakStartMinute: 800, breakEndMinute: 830 });
    expect(late.map((item) => item.type)).toEqual(["depart", "stop", "stop", "stop", "break", "return"]);
    const none = buildTimeline(stops, { startMinute: 450, endMinute: 900, breakStartMinute: null, breakEndMinute: null });
    expect(none.map((item) => item.type)).toEqual(["depart", "stop", "stop", "stop", "return"]);
  });
});
