// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planningFixture } from "@/test/planning-fixtures";
import type { TripView } from "@/lib/planning/types";
import { PlanningActivityProvider } from "./planning-activity";
import { TripPanel } from "./trip-panel";

// The server actions are not loaded: only what the panel sends them is checked.
const actions = vi.hoisted(() => ({
  lockTrip: vi.fn(async () => ({ ok: true, message: "Course figée." })),
  unlockTrip: vi.fn(async () => ({ ok: true, message: "Course défigée." })),
  moveTrip: vi.fn(async () => ({ ok: true, message: "Course déplacée." })),
}));
vi.mock("./actions", () => actions);

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function renderPanel(trip: TripView, props: { replanBlocked?: string | null; lockBlocked?: string | null } = {}) {
  const { trips, vehicles } = planningFixture();
  const onClose = vi.fn();
  const onSelectTrip = vi.fn();
  render(
    <PlanningActivityProvider timeLimitSec={10}>
      <TripPanel
        trip={trip}
        trips={trips}
        vehicles={vehicles}
        violations={[]}
        date="2026-11-10"
        replanBlocked={props.replanBlocked ?? null}
        lockBlocked={props.lockBlocked ?? null}
        onSelectTrip={onSelectTrip}
        onClose={onClose}
      />
    </PlanningActivityProvider>,
  );
  return { onClose, onSelectTrip };
}

const moveSelect = () => screen.getByLabelText("Déplacer vers…") as HTMLSelectElement;
const optionLabels = () => Array.from(moveSelect().options).map((o) => o.textContent);

describe("TripPanel (panneau course)", () => {
  it("offers only the available vehicles of an allowed type, other than the trip's own", () => {
    renderPanel(planningFixture().trips["trip-a"]!);
    expect(optionLabels()).toEqual(["Choisir un véhicule", "VSL 1 (Marseille) — libre"]);
  });

  it("offers nothing to an ambulance trip without another ambulance, and says so", () => {
    renderPanel({ ...planningFixture().trips["trip-a"]!, allowedVehicleTypes: ["AMBULANCE"], vehicleId: "amb-1" });
    expect(optionLabels()).toEqual(["Aucun véhicule compatible disponible"]);
    expect(moveSelect().disabled).toBe(true);
  });

  it("moves the trip to the chosen vehicle, the button enabled only once a vehicle is chosen", async () => {
    renderPanel(planningFixture().trips["trip-a"]!);
    const move = screen.getByRole("button", { name: "Déplacer" }) as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    fireEvent.change(moveSelect(), { target: { value: "vsl-1" } });
    expect(move.disabled).toBe(false);
    fireEvent.click(move);
    await waitFor(() => expect(actions.moveTrip).toHaveBeenCalledWith("trip-a", "vsl-1"));
  });

  it("freezes the trip on its vehicle, or unfreezes it, and blocks both on a past date", async () => {
    renderPanel(planningFixture().trips["trip-a"]!);
    fireEvent.click(screen.getByRole("button", { name: /Figer/ }));
    await waitFor(() => expect(actions.lockTrip).toHaveBeenCalledWith("trip-a", "taxi-1"));
    cleanup();

    renderPanel({ ...planningFixture().trips["trip-a"]!, lockedVehicleId: "taxi-1" });
    expect(screen.getByText(/figée sur Taxi 1 \(Marseille\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Défiger/ }));
    await waitFor(() => expect(actions.unlockTrip).toHaveBeenCalledWith("trip-a"));
    cleanup();

    renderPanel(planningFixture().trips["trip-a"]!, { lockBlocked: "Date passée : rien ne peut plus changer." });
    expect((screen.getByRole("button", { name: /Figer/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says why a cancelled trip cannot move, and names the shared trip, which can be opened", () => {
    const { onSelectTrip } = renderPanel(planningFixture().trips["trip-a"]!);
    fireEvent.click(screen.getByRole("button", { name: "Gérard Blanc" }));
    expect(onSelectTrip).toHaveBeenCalledWith("trip-b");
    cleanup();

    renderPanel({ ...planningFixture().trips["trip-a"]!, status: "CANCELLED" });
    expect(screen.getByText("Course annulée.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Déplacer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes from its button", () => {
    const { onClose } = renderPanel(planningFixture().trips["trip-a"]!);
    fireEvent.click(screen.getByRole("button", { name: "Fermer le détail de la course" }));
    expect(onClose).toHaveBeenCalled();
  });
});
