// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { depotGroupViews } from "@/lib/planning/filter";
import type { TripView, VehicleRowView, ViolationView } from "@/lib/planning/types";
import { indexViolations } from "@/lib/planning/violation-index";
import { planningFixture, tripView, vehicleRow } from "@/test/planning-fixtures";
import { Timeline, type TimelineProps } from "./timeline";

afterEach(cleanup);

const RANGE = { start: 360, end: 1140 };

function renderTimeline(
  props: Partial<Parameters<typeof Timeline>[0]> = {},
  data: { trips: Record<string, TripView>; vehicles: VehicleRowView[] } = planningFixture(),
) {
  const { trips, vehicles } = data;
  const onSelectTrip = vi.fn();
  const onSelectVehicle = vi.fn();
  render(
    <Timeline
      groups={depotGroupViews("2026-11-10", vehicles, vehicles, Object.values(trips), trips)}
      trips={trips}
      range={RANGE}
      selectedTripId={null}
      selectedVehicleId={null}
      onSelectTrip={onSelectTrip}
      onSelectVehicle={onSelectVehicle}
      {...props}
    />,
  );
  return { onSelectTrip, onSelectVehicle };
}

const rowOf = (vehicleId: string) => screen.getAllByRole("row").find((r) => r.getAttribute("data-vehicle-id") === vehicleId)!;

describe("Timeline (frise)", () => {
  it("shows one row per vehicle with its crew, trips and figures, and says why a vehicle is off", () => {
    renderTimeline();
    const grid = screen.getByRole("grid", { name: "Frise des tournées par véhicule" });
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(7); // header + 2 depot headers + 4 vehicles
    const taxi = rowOf("taxi-1");
    expect(within(taxi).getByRole("button", { name: /Taxi 1 \(Marseille\)/ })).toBeTruthy();
    expect(taxi.textContent).toContain("Julien Marchetti · 2 courses");
    expect(taxi.textContent).toContain("18 km");
    expect(taxi.textContent).toContain("Proposée");
    expect(rowOf("vsl-1").textContent).toContain("Disponible — aucune course");
    expect(rowOf("amb-1").textContent).toContain("+ Laurent Giraud");
    expect(rowOf("vsl-2").textContent).toContain("Indisponible : révision au garage");
  });

  it("groups the vehicles by depot, alphabetically, each with its subtotals", () => {
    renderTimeline();
    const headers = screen.getAllByRole("button", { name: /^Dépôt / });
    expect(headers.map((h) => h.textContent)).toEqual(["Dépôt Manosque", "Dépôt Marseille"]);
    const marseille = headers[1]!.closest("[data-depot-header]")!;
    expect(marseille.textContent).toContain("3 véhicules");
    expect(marseille.textContent).toContain("2 courses");
    expect(marseille.textContent).toMatch(/18\s*km/);
    expect(marseille.textContent).toMatch(/vide\s*34\s*%/);
  });

  it("folds a depot group: its rows are no longer drawn, the header says it", () => {
    const onToggleGroup = vi.fn();
    renderTimeline({ collapsed: new Set(["depot-marseille"]), onToggleGroup });
    const header = screen.getByRole("button", { name: "Dépôt Marseille" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Taxi 1 \(Marseille\)/ })).toBeNull();
    fireEvent.click(header);
    expect(onToggleGroup).toHaveBeenCalledWith("depot-marseille");
  });

  it("keeps a folded group open while one of its vehicles is selected", () => {
    renderTimeline({ collapsed: new Set(["depot-marseille"]), selectedVehicleId: "taxi-1" });
    expect(screen.getByRole("button", { name: "Dépôt Marseille" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Taxi 1 \(Marseille\)/ })).toBeTruthy();
  });

  it("counts the locked trips on the row, and draws 28 px rows on one line in the compact density", () => {
    const { trips, vehicles } = planningFixture();
    const locked = { ...trips, "trip-a": { ...trips["trip-a"]!, lockedVehicleId: "taxi-1" } };
    renderTimeline({ compact: true }, { trips: locked, vehicles });
    const taxi = rowOf("taxi-1");
    expect(taxi.textContent).toContain("1 course figée");
    // One line: no crew line, the track 24 px high (h-6 + 2 × 2 px).
    expect(taxi.textContent).not.toContain("Julien Marchetti");
    expect(taxi.querySelector("[role='gridcell']")?.className).toContain("h-6");
    expect(screen.getByRole("button", { name: "Dépôt Marseille" }).closest("[data-depot-header]")?.textContent).toContain("1 figée");
    // The locked trip's block has the dark left edge.
    expect(document.querySelector("[data-trip-block='trip-a']")?.className).toContain("border-slate-900");
    // One band of 24 px: the shared pair on board together becomes one target listing both.
    expect(screen.getByRole("button", { name: /^2 courses de 06:50 à 07:21 : Monique Aubert, Gérard Blanc/ }).textContent).toBe("+2");
  });

  it("marks a negative margin in red", () => {
    renderTimeline();
    const margin = screen.getAllByRole("gridcell").find((cell) => /−4\s*€|-4\s*€/.test(cell.textContent ?? ""));
    expect(margin?.className).toContain("text-red-700");
  });

  it("draws each trip as a block from pick-up to drop-off with the patient's initials, shared trips in two lanes", () => {
    renderTimeline();
    const a = document.querySelector<HTMLElement>("[data-trip-block='trip-a']")!;
    const b = document.querySelector<HTMLElement>("[data-trip-block='trip-b']")!;
    // 06:50 → 07:20 on 06:00 → 19:00.
    expect(parseFloat(a.style.left)).toBeCloseTo((50 / 780) * 100);
    expect(parseFloat(a.style.width)).toBeCloseTo((30 / 780) * 100);
    expect(a.textContent).toBe("MA");
    // 21 min at 0.72 px a minute: 15 px, no room for the initials.
    expect(b.textContent).toBe("");
    // On board together: one lane each, hatched (shared).
    expect(a.style.top).not.toBe(b.style.top);
    expect(a.style.backgroundImage).toContain("repeating-linear-gradient");
    expect(a.style.backgroundColor).not.toBe("");
  });

  it("selects a trip from its block and a vehicle from its name", () => {
    const { trips, vehicles } = planningFixture();
    const locked = { ...trips, "trip-a": { ...trips["trip-a"]!, lockedVehicleId: "taxi-1" } };
    const { onSelectTrip, onSelectVehicle } = renderTimeline({}, { trips: locked, vehicles });
    const target = screen.getByRole("button", { name: /^06:50 – 07:20 · Monique Aubert/ });
    expect(target.getAttribute("aria-label")).toContain("Course figée sur ce véhicule");
    fireEvent.click(target);
    expect(onSelectTrip).toHaveBeenCalledWith("trip-a");
    fireEvent.click(screen.getByRole("button", { name: /VSL 1 \(Marseille\)/ }));
    expect(onSelectVehicle).toHaveBeenCalledWith("vsl-1");
  });

  it("shows the selection: the trip's target is pressed, its row highlighted, the shared trip named, the appointment marked", () => {
    renderTimeline({ selectedTripId: "trip-a", selectedVehicleId: "taxi-1" });
    const target = screen.getByRole("button", { name: /^06:50 – 07:20 · Monique Aubert/ });
    expect(target.getAttribute("aria-pressed")).toBe("true");
    expect(target.getAttribute("aria-label")).toContain("Partagée avec Gérard Blanc");
    expect(screen.getByRole("button", { name: /Taxi 1 \(Marseille\)/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /VSL 1 \(Marseille\)/ }).getAttribute("aria-pressed")).toBe("false");
    // RDV 07:30, dropped off at 07:20: 10 min of margin, no alert.
    const mark = rowOf("taxi-1").querySelector("[data-appointment-mark]")!;
    expect(mark.textContent).toBe("RDV 07:30");
    expect(mark.className).toContain("border-slate-900");
  });

  it("flags the selected trip's appointment when the margin is under 5 minutes", () => {
    const { trips, vehicles } = planningFixture();
    const tight = { ...trips, "trip-a": { ...trips["trip-a"]!, plannedDropoffMinute: 447 } };
    renderTimeline({ selectedTripId: "trip-a", selectedVehicleId: "taxi-1" }, { trips: tight, vehicles });
    const mark = rowOf("taxi-1").querySelector("[data-appointment-mark]")!;
    expect(mark.textContent).toBe("RDV 07:30 · marge 3 min");
    expect(mark.className).toContain("border-dashed");
    expect(mark.querySelector("svg")).toBeTruthy();
  });

  it("merges trips too close to click apart into one « +3 » target that lists them", () => {
    const stop = (id: string, tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, minute: number) => ({
      id,
      sequence,
      tripId,
      kind,
      lat: 43.3,
      lng: 5.4,
      address: "Marseille",
      arrivalMinute: minute,
      startMinute: minute,
      departureMinute: minute + 2,
      loadAfter: kind === "PICKUP" ? 1 : 0,
      completed: false,
    });
    const names = ["Monique Aubert", "Gérard Blanc", "Colette Imbert"];
    const trips = Object.fromEntries(
      names.map((patientName, i) => [
        `t${i}`,
        tripView({ id: `t${i}`, patientName, coPassengerTripIds: [], shared: false, plannedPickupMinute: 600 + i * 12, plannedDropoffMinute: 608 + i * 12 }),
      ]),
    );
    const base = vehicleRow();
    const vehicles = [
      vehicleRow({
        route: {
          ...base.route!,
          tripCount: 3,
          stops: names.flatMap((_, i) => [stop(`p${i}`, `t${i}`, "PICKUP", i * 2, 600 + i * 12), stop(`d${i}`, `t${i}`, "DROPOFF", i * 2 + 1, 608 + i * 12)]),
        },
      }),
    ];
    const { onSelectTrip } = renderTimeline({}, { trips, vehicles });
    const cluster = screen.getByRole("button", { name: /^3 courses de 10:00 à 10:32 : Monique Aubert, Gérard Blanc, Colette Imbert/ });
    expect(cluster.textContent).toBe("+3");
    expect(cluster.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(cluster);
    const dialog = screen.getByRole("dialog", { name: "3 courses de 10:00 à 10:32" });
    const choices = within(dialog).getAllByRole("button");
    expect(choices.map((c) => c.textContent?.slice(0, 13))).toEqual(["10:00 – 10:08", "10:12 – 10:20", "10:24 – 10:32"]);
    fireEvent.click(within(dialog).getByRole("button", { name: /Gérard Blanc/ }));
    expect(onSelectTrip).toHaveBeenCalledWith("t1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pins the trips without a vehicle on an « À placer » row, on the window where they must be served", () => {
    const { onSelectTrip } = renderTimeline({ unassignedTripIds: ["trip-c"], waitWindows: { beforeAppointmentMin: 30, afterSessionMin: 15 } });
    const pinned = document.querySelector<HTMLElement>("[data-pinned-row]")!;
    expect(pinned.textContent).toContain("À placer");
    expect(pinned.textContent).toContain("1 course sans véhicule");
    // Outbound, RDV 07:30: the drop-off window 07:00 → 07:30.
    const block = pinned.querySelector<HTMLElement>("[data-trip-block='trip-c']")!;
    expect(parseFloat(block.style.left)).toBeCloseTo((60 / 780) * 100);
    expect(block.className).toContain("border-dashed");
    const target = within(pinned).getByRole("button", { name: /À placer · Colette Imbert.*Arrivée attendue de 07:00 à 07:30/ });
    fireEvent.click(target);
    expect(onSelectTrip).toHaveBeenCalledWith("trip-c");
    // The depot headers stick under the axis and the pinned row.
    expect(screen.getByRole("button", { name: "Dépôt Marseille" }).closest<HTMLElement>("[data-depot-header]")!.style.top).toBe("61px");
  });

  it("shows a vehicle's violations on its row and a trip's by a shape and its label, not only a color", () => {
    const { trips, vehicles } = planningFixture();
    const violations: ViolationView[] = [
      { code: "TIME_WINDOW", label: "Hors fenêtre horaire", message: "…", tripId: "trip-a", vehicleId: null },
      { code: "SHIFT", label: "Hors horaires du chauffeur", message: "…", tripId: null, vehicleId: "taxi-1" },
    ];
    renderTimeline({ violations: indexViolations(violations, trips) }, { trips, vehicles });
    const taxi = rowOf("taxi-1");
    expect(within(taxi).getByRole("button", { name: /Taxi 1 \(Marseille\)/ }).textContent).toContain(
      "2 violations : Hors fenêtre horaire, Hors horaires du chauffeur",
    );
    expect(screen.getByRole("button", { name: /Monique Aubert.*Violation : Hors fenêtre horaire/ })).toBeTruthy();
    expect(document.querySelector("[data-trip-block='trip-a']")?.className).toContain("outline-dashed");
    expect(rowOf("vsl-1").textContent).not.toContain("violation");
  });

  it("shows the free slots of 30 min or more, and names them for screen readers", () => {
    renderTimeline();
    // Shift 06:00 – 18:30, route 06:40 – 07:50.
    expect(rowOf("taxi-1").textContent).toContain("Créneaux libres : 06:00 – 06:40, 07:50 – 18:30.");
    expect(rowOf("taxi-1").querySelectorAll("[title^='Libre de']")).toHaveLength(2);
  });

  it("zooms in with a widened track scrolling sideways, the figures under the vehicle's name", () => {
    const onZoomChange = vi.fn();
    renderTimeline({ zoom: "4h", onZoomChange });
    const grid = screen.getByRole("grid");
    expect(grid.style.getPropertyValue("--track-w")).toBe("calc((100cqw - 14rem) * 3.25)");
    expect(within(screen.getByRole("group", { name: "Zoom de la frise" })).getByRole("radio", { name: "4 h à l'écran" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: "2 h à l'écran" }));
    expect(onZoomChange).toHaveBeenCalledWith("2h");
    // Hourly labels, no figure columns.
    expect(screen.getAllByRole("columnheader").filter((h) => h.className.includes("hidden"))).toHaveLength(5);
  });
});

describe("Timeline from the keyboard", () => {
  it("is one Tab stop; the arrows move between vehicles and trips", () => {
    renderTimeline({ onToggleGroup: vi.fn() });
    const grid = screen.getByRole("grid");
    const stops = () => Array.from(grid.querySelectorAll<HTMLElement>("[tabindex='0']"));
    expect(stops()).toHaveLength(1);
    const first = stops()[0]!;
    expect(first.textContent).toBe("Dépôt Manosque");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("VSL 2");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Dépôt Marseille");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Taxi 1");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toContain("Monique Aubert");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toContain("Gérard Blanc");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement?.textContent).toContain("Taxi 1");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.getAttribute("aria-label")).toContain("Gérard Blanc");
    // Still a single Tab stop: the one the arrows reached.
    expect(stops()).toEqual([document.activeElement]);
  });

  it("puts the Tab stop on the selected trip", () => {
    renderTimeline({ selectedTripId: "trip-b", selectedVehicleId: "taxi-1" });
    const stops = Array.from(screen.getByRole("grid").querySelectorAll<HTMLElement>("[tabindex='0']"));
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("aria-label")).toContain("Gérard Blanc");
  });
});

/** The timeline as an element, to render it again with other props (zoom, selection). */
function timelineElement(
  props: Partial<TimelineProps> = {},
  data: { trips: Record<string, TripView>; vehicles: VehicleRowView[] } = planningFixture(),
) {
  const { trips, vehicles } = data;
  return (
    <Timeline
      groups={depotGroupViews("2026-11-10", vehicles, vehicles, Object.values(trips), trips)}
      trips={trips}
      range={RANGE}
      selectedTripId={null}
      selectedVehicleId={null}
      onSelectTrip={vi.fn()}
      onSelectVehicle={vi.fn()}
      {...props}
    />
  );
}

/** Three trips 12 minutes apart on Taxi 1: one « +3 » target at the whole day's width. */
function closeTrips() {
  const stop = (id: string, tripId: string, kind: "PICKUP" | "DROPOFF", sequence: number, minute: number) => ({
    id,
    sequence,
    tripId,
    kind,
    lat: 43.3,
    lng: 5.4,
    address: "Marseille",
    arrivalMinute: minute,
    startMinute: minute,
    departureMinute: minute + 2,
    loadAfter: kind === "PICKUP" ? 1 : 0,
    completed: false,
  });
  const names = ["Monique Aubert", "Gérard Blanc", "Colette Imbert"];
  const trips = Object.fromEntries(
    names.map((patientName, i) => [
      `t${i}`,
      tripView({ id: `t${i}`, patientName, coPassengerTripIds: [], shared: false, plannedPickupMinute: 600 + i * 12, plannedDropoffMinute: 608 + i * 12 }),
    ]),
  );
  const base = vehicleRow();
  const route = {
    ...base.route!,
    tripCount: 3,
    stops: names.flatMap((_, i) => [stop(`p${i}`, `t${i}`, "PICKUP", i * 2, 600 + i * 12), stop(`d${i}`, `t${i}`, "DROPOFF", i * 2 + 1, 608 + i * 12)]),
  };
  return { trips, vehicles: [vehicleRow({ route })] };
}

describe("Timeline: the selected trip's appointment", () => {
  it("says a late drop-off and a session's end in the panel's words, under the pinned headers and column", () => {
    const { trips, vehicles } = planningFixture();
    const late = { ...trips, "trip-a": { ...trips["trip-a"]!, plannedDropoffMinute: 455 } };
    render(timelineElement({ selectedTripId: "trip-a", selectedVehicleId: "taxi-1" }, { trips: late, vehicles }));
    const mark = rowOf("taxi-1").querySelector<HTMLElement>("[data-appointment-mark]")!;
    expect(mark.textContent).toBe("RDV 07:30 · 5 min de retard");
    // Its track is a stacking context of its own: the line (z-index inside the track) never paints over the
    // sticky axis (z-30), « À placer » (27), the depot headers (25) or the vehicle column (22).
    const track = mark.closest<HTMLElement>("[role='gridcell']")!;
    expect(track.className).toContain("isolate");
    cleanup();

    const back = { ...trips, "trip-a": { ...trips["trip-a"]!, direction: "RETURN" as const, appointmentMinute: null, readyMinute: 655 } };
    render(timelineElement({ selectedTripId: "trip-a", selectedVehicleId: "taxi-1" }, { trips: back, vehicles }));
    expect(rowOf("taxi-1").querySelector("[data-appointment-mark]")?.textContent).toBe("Fin de séance 10:55");
  });
});

describe("Timeline zoom", () => {
  const VISIBLE = 800;
  const COLUMN = 224;
  beforeEach(() => {
    // Layout jsdom does not compute: the vehicle column, and the track as many times wider as the zoom says.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") !== "columnheader") return 0;
      if (this.classList.contains("sticky")) return COLUMN;
      const factor = /\* ([\d.]+)\)/.exec(this.closest<HTMLElement>("[role='grid']")?.style.getPropertyValue("--track-w") ?? "")?.[1];
      return VISIBLE * (factor ? Number(factor) : 1);
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.querySelector(":scope > [role='grid']") ? COLUMN + VISIBLE : 0;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const box = () => screen.getByRole("grid").parentElement!;
  /** Minute at the middle of the visible track. */
  const middle = (zoomWidth: number) => RANGE.start + ((box().scrollLeft + VISIBLE / 2) / zoomWidth) * (RANGE.end - RANGE.start);

  it("from the whole day, centers the selected trip, whatever an earlier zoom had scrolled to", () => {
    const { rerender } = render(timelineElement({ zoom: "4h" }));
    // 4 h, scrolled to the evening, back to the whole day, the earliest trip selected, then 2 h.
    box().scrollLeft = 2000;
    fireEvent.scroll(box());
    rerender(timelineElement({ zoom: "day" }));
    expect(box().scrollLeft).toBe(0);
    rerender(timelineElement({ zoom: "day", selectedTripId: "trip-a", selectedVehicleId: "taxi-1" }));
    rerender(timelineElement({ zoom: "2h", selectedTripId: "trip-a", selectedVehicleId: "taxi-1" }));
    // Trip A: 06:55 – 07:20, its middle at 07:07:30.
    expect(middle(VISIBLE * 6.5)).toBeCloseTo(427.5, 1);
  });

  it("with nothing selected, starts at the first route (not the empty early hours), then keeps the middle", () => {
    const { rerender } = render(timelineElement({ zoom: "day" }));
    rerender(timelineElement({ zoom: "4h" }));
    // Taxi 1 leaves at 06:40: at the left edge, 5 % of the view before it.
    const track4h = VISIBLE * 3.25;
    expect(RANGE.start + (box().scrollLeft / track4h) * 780).toBeCloseTo(400 - 0.05 * 240, 1);
    const center = middle(track4h);
    rerender(timelineElement({ zoom: "2h" }));
    expect(middle(VISIBLE * 6.5)).toBeCloseTo(center, 1);
  });
});

describe("Timeline: the list of a « +3 »", () => {
  it("keeps the focus inside until a choice or Escape, which gives it back to its target", () => {
    render(timelineElement({ onZoomChange: vi.fn() }, closeTrips()));
    const cluster = screen.getByRole("button", { name: /^3 courses de 10:00/ });
    fireEvent.click(cluster);
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    expect(document.activeElement).toBe(buttons[0]);
    // Tab from the last one wraps to the first, Shift + Tab from the first to the last.
    buttons.at(-1)!.focus();
    fireEvent.keyDown(buttons.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons.at(-1));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(cluster);
  });

  it("« Zoomer sur ce créneau » zooms in and gives the focus to the first trip's target, not to the page", () => {
    const onZoomChange = vi.fn();
    const data = closeTrips();
    const { rerender } = render(timelineElement({ onZoomChange }, data));
    fireEvent.click(screen.getByRole("button", { name: /^3 courses de 10:00/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Zoomer sur ce créneau" }));
    expect(onZoomChange).toHaveBeenCalledWith("2h");
    rerender(timelineElement({ onZoomChange, zoom: "2h" }, data));
    expect((document.activeElement as HTMLElement | null)?.dataset.tripIds?.split(" ")).toContain("t0");
  });
});

describe("Timeline from the keyboard: Tab stop and depot headers", () => {
  const tabbable = () =>
    Array.from(screen.getByRole("grid").querySelectorAll<HTMLButtonElement>("button")).filter((b) => !b.disabled && b.tabIndex >= 0);

  it("stays one Tab stop when a depot's button is enabled or disabled without the timeline drawing again", async () => {
    // A depot's « Défiger », re-rendered alone (busy, a plan refreshed) as LockScopeButtons is.
    const store = { disabled: true, listeners: new Set<() => void>() };
    const set = (disabled: boolean) => {
      store.disabled = disabled;
      for (const listener of store.listeners) listener();
    };
    function DepotUnlock() {
      const disabled = useSyncExternalStore(
        (listener) => {
          store.listeners.add(listener);
          return () => store.listeners.delete(listener);
        },
        () => store.disabled,
      );
      return (
        <button type="button" disabled={disabled}>
          Défiger le dépôt
        </button>
      );
    }
    render(timelineElement({ onToggleGroup: vi.fn(), groupActions: () => <DepotUnlock /> }));
    expect(tabbable()).toHaveLength(1);
    act(() => set(false));
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]!.textContent).toBe("Dépôt Manosque");

    // The Tab stop itself disabled: another item takes it.
    const unlock = screen.getAllByRole("button", { name: "Défiger le dépôt" })[0]!;
    act(() => unlock.focus());
    expect(tabbable()).toEqual([unlock]);
    act(() => set(true));
    await waitFor(() => expect(tabbable()).toHaveLength(1));
    expect(tabbable()[0]!.textContent).toBe("Dépôt Manosque");
  });

  it("keeps the time across a depot's header: ↓ lands on its fold toggle, the next ↓ on the trip at the same time", () => {
    // Positions jsdom does not compute: the vehicle column at 0–200 px, the track from 224 px, 8 px per percent.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const percent = (value: string) => (value.endsWith("%") ? parseFloat(value) : null);
      const left = percent(this.style.left);
      const width = percent(this.style.width);
      const x = left !== null ? 224 + left * 8 : 0;
      const w = width !== null ? width * 8 : 200;
      return { x, y: 0, left: x, right: x + w, top: 0, bottom: 10, width: w, height: 10, toJSON: () => ({}) } as DOMRect;
    });
    const { trips, vehicles } = planningFixture();
    const taxi = vehicles[0]!;
    const manosque = vehicles.map((v) =>
      v.id === "vsl-2"
        ? {
            ...v,
            available: true,
            unavailableReason: null,
            route: { ...taxi.route!, tripCount: 1, stops: taxi.route!.stops.filter((s) => s.tripId === "trip-a").map((s) => ({ ...s, tripId: "trip-m" })) },
          }
        : v,
    );
    const withM = { ...trips, "trip-m": tripView({ id: "trip-m", patientName: "Marcel Morel", vehicleId: "vsl-2", coPassengerTripIds: [], shared: false }) };
    render(timelineElement({ onToggleGroup: vi.fn(), groupActions: () => <button type="button">Figer le dépôt</button> }, { trips: withM, vehicles: manosque }));
    const start = screen.getByRole("button", { name: /Marcel Morel/ });
    act(() => start.focus());
    fireEvent.keyDown(start, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Dépôt Marseille");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset.tripIds).toMatch(/trip-a|trip-b/);
    // ← → still reach the depot's own buttons from its toggle.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("Dépôt Marseille");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("Figer le dépôt");
    vi.restoreAllMocks();
  });
});
