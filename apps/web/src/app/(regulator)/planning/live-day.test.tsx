// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSnapshot } from "@/lib/planning/live-load";
import { planningFixture } from "@/test/planning-fixtures";
import { LiveDayBar, LiveDayProvider, useLiveDay } from "./live-day";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// Monday 16 November 2026, 10:42 in Paris.
const SERVER = Date.parse("2026-11-16T09:42:00.000Z");

function snapshot(extra: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    date: "2026-11-16",
    serverTime: SERVER,
    nowMinute: 642,
    planKey: "k1",
    version: "v1",
    run: "run1",
    running: false,
    done: {},
    trips: {},
    returnsToCheck: [],
    roadmaps: {},
    requests: [],
    ...extra,
  };
}

function Probe() {
  const live = useLiveDay();
  if (!live) return <p>sans suivi</p>;
  const stop = live.vehicles[0]?.route?.stops[0];
  return (
    <p data-testid="probe">
      {live.nowMinute}|{String(stop?.completed)}|{String(live.planChanged)}
    </p>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderLive(initial: LiveSnapshot) {
  const { vehicles, trips } = planningFixture();
  return render(
    <LiveDayProvider initial={initial} vehicles={vehicles} trips={Object.values(trips)} maxTotalWaitMin={45}>
      <LiveDayBar />
      <Probe />
    </LiveDayProvider>,
  );
}

describe("« Suivi du jour »", () => {
  it("polls at once, follows the server's clock, and applies the statuses the crews recorded", async () => {
    const stopId = planningFixture().vehicles[0]!.route!.stops[0]!.id;
    fetchMock.mockResolvedValue({ ok: true, type: "basic", json: async () => snapshot({ serverTime: SERVER + 60_000, done: { [stopId]: 430 } }) });
    renderLive(snapshot());
    expect(screen.getByRole("status").textContent).toContain("Suivi du jour");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toMatch(/\|true\|false$/));
    expect(fetchMock.mock.calls[0]![0]).toBe("/planning/suivi?date=2026-11-16");
    expect(screen.getByRole("status").textContent).toContain("Actualisé à 10:43:00");
    expect(screen.getByRole("status").textContent).toMatch(/1\/1 tournée commencée · 1\/\d+ arrêts faits/);
  });

  it("says the plan changed when its key moved (« Recharger »), not for a status", async () => {
    fetchMock.mockResolvedValue({ ok: true, type: "basic", json: async () => snapshot({ serverTime: SERVER + 30_000, planKey: "k2" }) });
    renderLive(snapshot());
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toMatch(/\|true$/));
  });

  it("offers « Plein écran »", () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    renderLive(snapshot());
    expect(screen.getByRole("button", { name: "Plein écran" })).toBeTruthy();
  });
});
