// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanningMapProps } from "@/components/map/planning-map";
import { DISPLAY_PALETTE } from "@/lib/planning/colors";
import type { DayKpis, TripView } from "@/lib/planning/types";
import { planningFixture } from "@/test/planning-fixtures";
import { PlanningActivityProvider } from "./planning-activity";
import { PlanningBoard } from "./planning-board";

// The server actions are not loaded, and the map (WebGL) is replaced by what the board gives it.
const actions = vi.hoisted(() => ({
  findPlaces: vi.fn(async () => ({ ok: false, error: "Service indisponible." })),
  checkDraft: vi.fn(),
}));
vi.mock("./actions", () => ({
  lockTrip: vi.fn(),
  unlockTrip: vi.fn(),
  moveTrip: vi.fn(),
  proposeExceptionalAmbulance: vi.fn(),
  lockRoutes: vi.fn(),
  unlockRoutes: vi.fn(),
  changeRouteCrew: vi.fn(),
  findPlaces: actions.findPlaces,
  placeTrip: vi.fn(),
  checkDraft: actions.checkDraft,
  saveDraft: vi.fn(),
}));
// The filter is read from the address (Next.js keeps useSearchParams in step with it in the app).
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ refresh: vi.fn() }),
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
  actions.findPlaces.mockClear();
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

function board(props: { planned?: boolean; trips?: TripView[]; initialTripId?: string | null; initialPlace?: boolean } = {}) {
  const { trips, vehicles } = planningFixture();
  const list: TripView[] = props.trips ?? Object.values(trips);
  return (
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
        placeBlocked={null}
        initialTripId={props.initialTripId ?? null}
        initialPlace={props.initialPlace}
        crewChoices={[]}
        crewRules={{ minPairOverlapMin: 60 }}
        crewChangeMode="route"
        crewChangeBlocked={null}
        version="v1"
      />
    </PlanningActivityProvider>
  );
}

function renderBoard(props: { planned?: boolean } = {}) {
  return render(board(props));
}

const announcement = () => document.querySelector("[aria-live='polite'].sr-only")?.textContent;
const mapVehicleIds = () => map.props?.vehicles.map((v) => v.id);

describe("PlanningBoard", () => {
  it("searches the places of a trip opened with ?placer=1 once: not again once it moved, nor on a reload", async () => {
    window.history.replaceState(null, "", "/planning?date=2026-11-10&trip=trip-c&placer=1");
    const { rerender } = render(board({ initialTripId: "trip-c", initialPlace: true }));
    await waitFor(() => expect(actions.findPlaces).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe("?date=2026-11-10&trip=trip-c");
    // « Appliquer » placed it on the VSL: the panel draws its places again, without searching.
    const moved = Object.values(planningFixture().trips).map((t) => (t.id === "trip-c" ? { ...t, vehicleId: "vsl-1", lockedVehicleId: "vsl-1" } : t));
    rerender(board({ trips: moved, initialTripId: "trip-c", initialPlace: true }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Chercher" })).toBeTruthy();
    expect(actions.findPlaces).toHaveBeenCalledTimes(1);
  });

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

describe("PlanningBoard: the drag-and-drop draft (INS-03)", () => {
  const draftView = {
    version: "v1",
    moves: [{ tripId: "trip-a", toVehicleId: "vsl-1", fromVehicleId: "taxi-1", ok: true, pickupMinute: 412, dropoffMinute: 440, deltaKm: -1, deltaMargin: 6 }],
    routes: [
      {
        vehicleId: "vsl-1",
        route: {
          startMinute: 400,
          endMinute: 450,
          distanceKm: 10,
          emptyKm: 3,
          revenue: 16,
          cost: 9,
          margin: 7,
          breakStartMinute: null,
          breakEndMinute: null,
          stops: [
            { tripId: "trip-a", kind: "PICKUP" as const, lat: 43.3, lng: 5.4, arrivalMinute: 412, startMinute: 412, departureMinute: 417, loadAfter: 1 },
            { tripId: "trip-a", kind: "DROPOFF" as const, lat: 43.3, lng: 5.4, arrivalMinute: 440, startMinute: 440, departureMinute: 445, loadAfter: 0 },
          ],
        },
      },
    ],
    trips: [{ tripId: "trip-a", vehicleId: "vsl-1", pickupMinute: 412, dropoffMinute: 440, shared: false, coPassengerTripIds: [], estimatedRevenue: 16, detourKm: 0 }],
    before: { served: 2, violations: 0, revenue: 30, margin: -3.7, km: 18.4 },
    after: { served: 2, violations: 0, revenue: 32, margin: 2.3, km: 17.4 },
    newViolations: [],
    shifted: [],
    question: null,
  };

  beforeEach(() => {
    window.sessionStorage.clear();
    actions.checkDraft.mockReset();
    actions.checkDraft.mockResolvedValue({ ok: true, view: draftView });
  });

  it("checks a drop with the server, draws the draft on the timeline and counts it, kept for the tab", async () => {
    renderBoard();
    const trip = document.querySelector<HTMLElement>("[data-trip-ids='trip-a']")!;
    trip.focus();
    fireEvent.keyDown(trip, { key: "m" });
    fireEvent.keyDown(trip, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(trip, { key: "Enter" });
    });
    expect(actions.checkDraft).toHaveBeenCalledWith("2026-11-10", [{ tripId: "trip-a", toVehicleId: "vsl-1" }]);
    const bar = await screen.findByRole("region", { name: "Brouillon de la frise" });
    expect(bar.textContent).toContain("1 modification non enregistrée");
    expect(bar.textContent).toContain("marge +6 €");
    const vsl = document.querySelector("[data-vehicle-id='vsl-1']")!;
    expect(vsl.textContent).toContain("Brouillon");
    expect(vsl.querySelector("[data-trip-ids='trip-a']")).not.toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem("opti-taxi:brouillon:2026-11-10") ?? "[]")).toEqual([{ tripId: "trip-a", toVehicleId: "vsl-1" }]);
    // The trip's panel says it is moved in the draft only.
    fireEvent.click(vsl.querySelector<HTMLElement>("[data-trip-ids='trip-a']")!);
    expect(document.body.textContent).toContain("Dans le brouillon, non enregistré : sur VSL 1 (Marseille), prise en charge 06:52");
    // « Annuler »: the plan in place again, nothing kept.
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.queryByRole("region", { name: "Brouillon de la frise" })).toBeNull();
    expect(window.sessionStorage.getItem("opti-taxi:brouillon:2026-11-10")).toBeNull();
  });

  it("takes a refused drop out of the draft, saying why", async () => {
    actions.checkDraft.mockResolvedValue({
      ok: true,
      view: { ...draftView, moves: [{ tripId: "trip-a", toVehicleId: "vsl-1", fromVehicleId: "taxi-1", ok: false, reason: "VSL 1 (Marseille) est en pause de 12:00 à 12:45." }], routes: [], trips: [] },
    });
    renderBoard();
    const trip = document.querySelector<HTMLElement>("[data-trip-ids='trip-a']")!;
    trip.focus();
    fireEvent.keyDown(trip, { key: "m" });
    fireEvent.keyDown(trip, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(trip, { key: "Enter" });
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Déplacement refusé pour la course de Monique Aubert (aller, RDV 07:30) : VSL 1 (Marseille) est en pause de 12:00 à 12:45.",
    );
    expect(screen.getByRole("region", { name: "Brouillon de la frise" }).textContent).not.toContain("modification");
    expect(window.sessionStorage.getItem("opti-taxi:brouillon:2026-11-10")).toBeNull();
  });

  it("checks again the draft kept for the date when the page opens", async () => {
    window.sessionStorage.setItem("opti-taxi:brouillon:2026-11-10", JSON.stringify([{ tripId: "trip-a", toVehicleId: "vsl-1" }]));
    renderBoard();
    await waitFor(() => expect(actions.checkDraft).toHaveBeenCalledWith("2026-11-10", [{ tripId: "trip-a", toVehicleId: "vsl-1" }]));
    expect((await screen.findByRole("region", { name: "Brouillon de la frise" })).textContent).toContain("1 modification non enregistrée");
  });
});
