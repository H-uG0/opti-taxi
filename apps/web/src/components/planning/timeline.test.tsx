// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { depotGroupViews } from "@/lib/planning/filter";
import { planningFixture } from "@/test/planning-fixtures";
import { Timeline } from "./timeline";

afterEach(cleanup);

const RANGE = { start: 360, end: 1140 };

function renderTimeline(props: Partial<Parameters<typeof Timeline>[0]> = {}) {
  const { trips, vehicles } = planningFixture();
  const onSelectTrip = vi.fn();
  const onSelectVehicle = vi.fn();
  render(
    <Timeline
      groups={depotGroupViews("2026-11-10", vehicles, vehicles, Object.values(trips), trips)}
      trips={trips}
      range={RANGE}
      selectedTripId={null}
      selectedVehicleId={null}
      violatingTripIds={new Set()}
      onSelectTrip={onSelectTrip}
      onSelectVehicle={onSelectVehicle}
      {...props}
    />,
  );
  return { onSelectTrip, onSelectVehicle };
}

describe("Timeline (frise)", () => {
  it("shows one row per vehicle with its crew, trips and figures, and says why a vehicle is off", () => {
    renderTimeline();
    const table = screen.getByRole("table", { name: "Frise des tournées par véhicule" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(7); // header + 2 depot headers + 4 vehicles
    const row = (vehicleId: string) => rows.find((r) => r.getAttribute("data-vehicle-id") === vehicleId)!;
    const taxi = row("taxi-1");
    expect(within(taxi).getByRole("button", { name: /Taxi 1 \(Marseille\)/ })).toBeTruthy();
    expect(taxi.textContent).toContain("Julien Marchetti · 2 courses");
    expect(taxi.textContent).toContain("18 km");
    expect(taxi.textContent).toContain("Proposée");
    expect(row("vsl-1").textContent).toContain("Disponible — aucune course");
    expect(row("amb-1").textContent).toContain("+ Laurent Giraud");
    expect(row("vsl-2").textContent).toContain("Indisponible : révision au garage");
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
    render(
      <Timeline
        groups={depotGroupViews("2026-11-10", vehicles, vehicles, Object.values(locked), locked)}
        trips={locked}
        range={RANGE}
        selectedTripId={null}
        selectedVehicleId={null}
        violatingTripIds={new Set()}
        onSelectTrip={vi.fn()}
        onSelectVehicle={vi.fn()}
        compact
      />,
    );
    const taxi = screen.getAllByRole("row").find((r) => r.getAttribute("data-vehicle-id") === "taxi-1")!;
    expect(taxi.textContent).toContain("1 course figée");
    // One line: no crew line, the track 24 px high (h-6 + 2 × 2 px).
    expect(taxi.textContent).not.toContain("Julien Marchetti");
    expect(taxi.querySelector("[role='cell']")?.className).toContain("h-6");
    expect(screen.getByRole("button", { name: "Dépôt Marseille" }).closest("[data-depot-header]")?.textContent).toContain("1 figée");
  });

  it("marks a negative margin in red", () => {
    renderTimeline();
    const margin = screen.getAllByRole("cell").find((cell) => /−4\s*€|-4\s*€/.test(cell.textContent ?? ""));
    expect(margin?.className).toContain("text-red-700");
  });

  it("selects a trip from its pickup stop (keyboard reachable) and a vehicle from its name", () => {
    const { onSelectTrip, onSelectVehicle } = renderTimeline();
    const pickup = screen.getByRole("button", { name: /Prise en charge · Monique Aubert/ });
    expect(pickup.getAttribute("tabindex")).toBe("0");
    fireEvent.click(pickup);
    expect(onSelectTrip).toHaveBeenCalledWith("trip-a");
    // A drop-off stop is clickable but out of the tab order (one stop per trip in the keyboard path).
    expect(screen.getByRole("button", { name: /Dépose · Monique Aubert/ }).getAttribute("tabindex")).toBe("-1");
    fireEvent.click(screen.getByRole("button", { name: /VSL 1 \(Marseille\)/ }));
    expect(onSelectVehicle).toHaveBeenCalledWith("vsl-1");
  });

  it("shows the selection: the trip's stop is pressed, its row highlighted, the shared trip named in the stop title", () => {
    renderTimeline({ selectedTripId: "trip-a", selectedVehicleId: "taxi-1" });
    const pickup = screen.getByRole("button", { name: /Prise en charge · Monique Aubert/ });
    expect(pickup.getAttribute("aria-pressed")).toBe("true");
    expect(pickup.getAttribute("aria-label")).toContain("Partagée avec Gérard Blanc");
    expect(screen.getByRole("button", { name: /Taxi 1 \(Marseille\)/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /VSL 1 \(Marseille\)/ }).getAttribute("aria-pressed")).toBe("false");
  });
});
