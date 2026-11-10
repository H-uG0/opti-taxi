// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanningMapProps } from "@/components/map/planning-map";
import { DISPLAY_PALETTE } from "@/lib/planning/colors";
import type { DayKpis, TripView } from "@/lib/planning/types";
import { planningFixture } from "@/test/planning-fixtures";
import { PlanningActivityProvider } from "./planning-activity";
import { PlanningBoard } from "./planning-board";

// The server actions are not loaded, and the map (WebGL) is replaced by what the board gives it.
vi.mock("./actions", () => ({
  lockTrip: vi.fn(),
  unlockTrip: vi.fn(),
  moveTrip: vi.fn(),
  proposeExceptionalAmbulance: vi.fn(),
  lockRoutes: vi.fn(),
  unlockRoutes: vi.fn(),
  changeRouteCrew: vi.fn(),
}));
// The filter is read from the address (Next.js keeps useSearchParams in step with it in the app).
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
const map = vi.hoisted(() => ({ props: null as PlanningMapProps | null }));
vi.mock("@/components/map/planning-map-lazy", () => ({
  PlanningMapLazy: (props: PlanningMapProps) => {
    map.props = props;
    return null;
  },
}));

afterEach(cleanup);
beforeEach(() => {
  map.props = null;
  window.history.replaceState(null, "", "/planning");
});

const KPIS: DayKpis = {
  tripsTotal: 3,
  tripsServed: 2,
  vehiclesUsed: 1,
  tripsPerVehicle: 2,
  totalKm: 18.4,
  emptyKm: 6.2,
  emptyKmRatio: 0.34,
  sharedTrips: 2,
  sharedTripRatio: 1,
  revenue: 30.4,
  margin: -3.7,
  violations: 0,
};

function renderBoard(props: { planned?: boolean } = {}) {
  const { trips, vehicles } = planningFixture();
  const list: TripView[] = Object.values(trips);
  render(
    <PlanningActivityProvider timeLimitSec={10}>
      <PlanningBoard
        date="2026-11-10"
        vehicles={vehicles}
        trips={list}
        unassigned={[{ tripId: "trip-c", reason: "Non affectée lors de la dernière optimisation" }]}
        violations={[]}
        violationsKnown
        staleTrips={[]}
        vehicleIssues={[]}
        droppedLocks={[]}
        timeRange={{ start: 360, end: 1140 }}
        waitWindows={{ beforeAppointmentMin: 30, afterSessionMin: 15 }}
        planned={props.planned ?? true}
        kpis={KPIS}
        replanBlocked={null}
        lockBlocked={null}
        initialTripId={null}
        crewChoices={[]}
        crewRules={{ minPairOverlapMin: 60 }}
        crewChangeMode="route"
        crewChangeBlocked={null}
        version="v1"
      />
    </PlanningActivityProvider>,
  );
}

const announcement = () => document.querySelector("[aria-live='polite'].sr-only")?.textContent;
const mapVehicleIds = () => map.props?.vehicles.map((v) => v.id);

describe("PlanningBoard", () => {
  it("goes to the next entry of «\u202fÀ traiter\u202f» with «\u202fN\u202f», selects it and says it", () => {
    renderBoard();
    act(() => {
      fireEvent.keyDown(document.body, { key: "n" });
    });
    expect(announcement()).toBe("À traiter, 1 sur 1\u00a0: Colette Imbert");
    expect(screen.getByRole("heading", { name: "Colette Imbert" })).toBeTruthy();
    // Not while typing.
    act(() => {
      fireEvent.keyDown(screen.getByPlaceholderText("Patient, véhicule, chauffeur…"), { key: "n" });
    });
    expect(announcement()).toBe("À traiter, 1 sur 1\u00a0: Colette Imbert");
  });

  it("names «\u202fN\u202f» after the panel's title before the first optimization", () => {
    renderBoard({ planned: false });
    act(() => {
      fireEvent.keyDown(document.body, { key: "n" });
    });
    expect(announcement()).toBe("Courses à planifier, 1 sur 1\u00a0: Colette Imbert");
    expect(map.props?.planned).toBe(false);
  });

  it("gives the timeline and the map the same display color per vehicle, and the map the vehicle's type", () => {
    renderBoard();
    const taxi = map.props?.vehicles.find((v) => v.id === "taxi-1");
    expect(taxi).toMatchObject({ type: "TAXI", color: DISPLAY_PALETTE[0] });
    const dot = document.querySelector<HTMLElement>("[data-vehicle-id='taxi-1'] [role='rowheader'] span[aria-hidden].rounded-full");
    expect(dot?.style.background).toBe("rgb(29, 78, 216)");
  });

  it("keeps «\u202fSélection seule\u202f» on while nothing is selected (it can be turned off) and applies it to the next selection without moving the map", () => {
    window.history.replaceState(null, "", "/planning?carte=selection");
    renderBoard();
    // Nothing selected: the map shows what the timeline shows, the button stays pressed and usable.
    expect(mapVehicleIds()?.sort()).toEqual(["amb-1", "taxi-1", "vsl-1", "vsl-2"]);
    expect(map.props?.selectionOnly).toBe(true);
    expect(map.props?.selectionOnlyWaiting).toBe(true);
    expect(map.props?.onSelectionOnlyChange).toBeTypeOf("function");
    const key = map.props?.datasetKey;

    // A trip selected: its vehicle only; the map is framed by its selection effect, not refitted as a new dataset.
    fireEvent.click(screen.getByRole("button", { name: /^06:50 – 07:20 · Monique Aubert/ }));
    expect(mapVehicleIds()).toEqual(["taxi-1"]);
    expect(map.props?.selectionOnlyWaiting).toBe(false);
    expect(map.props?.datasetKey).toBe(key);
    expect(map.props?.trips.map((t) => t.id).sort()).toEqual(["trip-a", "trip-b"]);

    // Escape: everything again, still on for the next selection.
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(mapVehicleIds()).toHaveLength(4);
    expect(map.props?.selectionOnly).toBe(true);
    expect(map.props?.datasetKey).toBe(key);
  });

  it("disables «\u202fSélection seule\u202f» only when it is off and nothing is selected", () => {
    renderBoard();
    expect(map.props?.selectionOnly).toBe(false);
    expect(map.props?.onSelectionOnlyChange).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Taxi 1 \(Marseille\)/ }));
    expect(map.props?.onSelectionOnlyChange).toBeTypeOf("function");
  });
});
