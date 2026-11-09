// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      rows={vehicles}
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
    expect(rows).toHaveLength(5); // header + 4 vehicles
    const taxi = rows[1]!;
    expect(within(taxi).getByRole("button", { name: /Taxi 1 \(Marseille\)/ })).toBeTruthy();
    expect(taxi.textContent).toContain("Julien Marchetti · 2 courses");
    expect(taxi.textContent).toContain("18 km");
    expect(taxi.textContent).toContain("Proposée");
    expect(rows[2]!.textContent).toContain("Disponible — aucune course");
    expect(rows[3]!.textContent).toContain("+ Laurent Giraud");
    expect(rows[4]!.textContent).toContain("Indisponible : révision au garage");
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
