import { describe, expect, it } from "vitest";
import type { RouteProjection, StopProjection } from "./live-day";
import { liveRowView, vehicleLiveView } from "./live-view";

function stop(id: string, state: StopProjection["state"], extra: Partial<StopProjection> = {}): StopProjection {
  return { stopId: id, tripId: `t${id}`, kind: "PICKUP", state, startMinute: 600, departureMinute: 605, delayMinutes: 0, overdueMinutes: null, ...extra };
}

function route(extra: Partial<RouteProjection>): RouteProjection {
  return {
    vehicleId: "v1",
    closed: 2,
    total: 6,
    started: true,
    finished: false,
    lastStatusMinute: 571,
    nextStopId: "s3",
    delayMinutes: 0,
    silentSinceMinute: null,
    stops: [stop("s1", "done", { departureMinute: 571 }), stop("s2", "closed"), stop("s3", "pending")],
    ...extra,
  };
}

describe("liveRowView", () => {
  it("shows the progress, and the delay from 5 min on, amber then red from 15 min", () => {
    expect(liveRowView(route({}))).toEqual({ label: "2/6", tone: "ok", title: "2 arrêts faits sur 6\u00a0; à l'heure" });
    expect(liveRowView(route({ delayMinutes: 4 })).tone).toBe("ok");
    expect(liveRowView(route({ delayMinutes: 8 }))).toEqual({ label: "2/6 · +8\u00a0min", tone: "late", title: "2 arrêts faits sur 6\u00a0; retard estimé 8\u00a0min" });
    expect(liveRowView(route({ delayMinutes: 20 })).tone).toBe("alert");
  });

  it("says a silent route and a stop overdue in red, a finished route done", () => {
    expect(liveRowView(route({ started: false, closed: 0, silentSinceMinute: 445 }))).toEqual({
      label: "Aucun statut",
      tone: "alert",
      title: "Tournée silencieuse\u00a0: aucun statut depuis 07:25",
    });
    const overdue = route({ stops: [stop("s3", "pending", { overdueMinutes: 14 })] });
    expect(liveRowView(overdue)).toMatchObject({ tone: "alert", title: "2 arrêts faits sur 6\u00a0; arrêt sans statut depuis 14\u00a0min" });
    expect(liveRowView(route({ finished: true, closed: 6 })).label).toBe("Terminée");
  });
});

describe("vehicleLiveView", () => {
  it("sums the route up and dates each stop: done, still to do, forgotten", () => {
    const view = vehicleLiveView(
      route({ delayMinutes: 12, stops: [stop("s1", "done", { departureMinute: 571 }), stop("s2", "missing"), stop("s3", "pending", { startMinute: 654, delayMinutes: 12 }), stop("s4", "pending")] }),
    );
    expect(view.summary).toBe("2 arrêts faits sur 6 · dernier statut à 09:31 · retard estimé 12\u00a0min");
    expect(view.alert).toBeNull();
    expect(view.stops).toEqual({
      s1: { text: "fait à 09:31", tone: "done" },
      s2: { text: "sans statut", tone: "alert" },
      s3: { text: "vers 10:54, +12\u00a0min", tone: "late" },
      s4: { text: "à l'heure", tone: "ok" },
    });
  });

  it("tells the regulator to call a silent crew", () => {
    expect(vehicleLiveView(route({ started: false, closed: 0, lastStatusMinute: null, silentSinceMinute: 445 })).alert).toBe(
      "Aucun statut depuis 07:25\u00a0: appelez l'équipage.",
    );
  });
});
