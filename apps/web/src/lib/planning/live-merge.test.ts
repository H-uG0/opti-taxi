import { describe, expect, it } from "vitest";
import { liveTrips, liveVehicles, projectionRoutes, projectionTrips } from "./live-merge";
import type { StopView, TripView, VehicleRowView } from "./types";

function stop(id: string, tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, completedMinute: number | null = null): StopView {
  return {
    id,
    sequence,
    tripId,
    kind,
    lat: 0,
    lng: 0,
    address: "",
    arrivalMinute: 480 + sequence * 10,
    startMinute: 480 + sequence * 10,
    departureMinute: 485 + sequence * 10,
    loadAfter: kind === "PICKUP" ? 1 : 0,
    completed: completedMinute !== null,
    completedMinute,
  };
}

function row(id: string, stops: StopView[] | null): VehicleRowView {
  return {
    id,
    label: id,
    registration: id,
    type: "TAXI",
    capacity: 2,
    color: "#000",
    depot: { id: "d", label: "D", lat: 0, lng: 0 },
    driverName: null,
    crewMateName: null,
    available: true,
    unavailableReason: null,
    shift: null,
    breakWindow: null,
    route: stops
      ? {
          id: `r-${id}`,
          status: "VALIDATED",
          startMinute: 470,
          endMinute: 600,
          distanceKm: 0,
          emptyKm: 0,
          revenue: 0,
          cost: 0,
          margin: 0,
          breakStartMinute: null,
          breakEndMinute: null,
          validatedAt: null,
          tripCount: 1,
          stops,
          driverId: null,
          crewMateId: null,
          remaining: null,
        }
      : null,
  };
}

const trip = (id: string, extra: Partial<TripView> = {}) =>
  ({ id, direction: "OUTBOUND", status: "ASSIGNED", appointmentMinute: 540, readyMinute: null, vehicleId: "v1", outboundNoShow: false, ...extra }) as TripView;

describe("liveVehicles", () => {
  const vehicles = [row("v1", [stop("s1", "a", "PICKUP", 1), stop("s2", "a", "DROPOFF", 2)]), row("v2", null), row("v3", [stop("s3", "b", "PICKUP", 1, 470)])];

  it("marks the stops the crews recorded, with their minute", () => {
    const next = liveVehicles(vehicles, { done: { s1: 492, s3: 470 }, trips: {}, returnsToCheck: [] });
    expect(next[0]?.route?.stops[0]).toMatchObject({ completed: true, completedMinute: 492 });
    expect(next[0]?.route?.stops[1]).toMatchObject({ completed: false, completedMinute: null });
  });

  it("keeps the objects of what did not change (memoized rows)", () => {
    const next = liveVehicles(vehicles, { done: { s3: 470 }, trips: {}, returnsToCheck: [] });
    expect(next[0]).toBe(vehicles[0]);
    expect(next[1]).toBe(vehicles[1]);
    expect(next[2]).toBe(vehicles[2]);
  });

  it("takes back a status undone by the crew", () => {
    const next = liveVehicles(vehicles, { done: {}, trips: {}, returnsToCheck: [] });
    expect(next[2]?.route?.stops[0]).toMatchObject({ completed: false, completedMinute: null });
  });
});

describe("liveTrips", () => {
  it("takes the status, the end of session and the return to check from the poll, keeping unchanged trips", () => {
    const trips = [trip("a"), trip("b", { direction: "RETURN", readyMinute: 700 }), trip("c")];
    const next = liveTrips(trips, { done: {}, trips: { a: { status: "PICKED_UP", readyMinute: null }, b: { status: "ASSIGNED", readyMinute: 660 }, c: { status: "ASSIGNED", readyMinute: null } }, returnsToCheck: ["b"] });
    expect(next[0]?.status).toBe("PICKED_UP");
    expect(next[1]).toMatchObject({ readyMinute: 660, outboundNoShow: true });
    expect(next[2]).toBe(trips[2]);
  });
});

describe("projection inputs", () => {
  it("gives the projection every route with its stops as recorded, and every trip", () => {
    const routes = projectionRoutes([row("v1", [stop("s1", "a", "PICKUP", 1, 492)]), row("v2", null)]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ vehicleId: "v1", startMinute: 470, stops: [{ id: "s1", completedMinute: 492, arrivalMinute: 490 }] });
    expect(projectionTrips([trip("a", { otherLegTripId: "b" })])[0]).toEqual({
      id: "a",
      direction: "OUTBOUND",
      status: "ASSIGNED",
      appointmentMinute: 540,
      readyMinute: null,
      vehicleId: "v1",
      otherLegTripId: "b",
    });
  });
});
