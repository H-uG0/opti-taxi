// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacesView } from "@/lib/planning/place-view";
import { planningFixture } from "@/test/planning-fixtures";
import { PlaceFinder } from "./place-finder";
import { PlanningActivityProvider } from "./planning-activity";

// The server actions are not loaded: what the finder sends them, and what it shows of their answer.
const actions = vi.hoisted(() => ({
  findPlaces: vi.fn(),
  placeTrip: vi.fn(),
}));
vi.mock("./actions", () => actions);

/** getByText reads the text with its no-break spaces as plain ones. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

const QUESTION = "Planning validé\u00a0: la feuille de route de VSL 1 (Marseille) change dès l'enregistrement, prévenez les chauffeurs. Appliquer quand même\u202f?";

function places(overrides: Partial<PlacesView> = {}): PlacesView {
  const option = {
    pickupMinute: 420,
    dropoffMinute: 445,
    shared: false,
    coPassengerTripIds: [],
    deltaKm: 4.2,
    deltaEmptyKm: 1.1,
    deltaDurationMin: 15,
    deltaRevenue: 18,
    deltaMargin: 9.6,
    shifts: [],
    remainingViolations: 0,
  };
  return {
    tripId: "trip-c",
    fromVehicleId: null,
    version: "v-42",
    options: [
      { ...option, vehicleId: "vsl-1", deltaMargin: 21, shared: true, coPassengerTripIds: ["trip-a"], shifts: [{ tripId: "trip-a", minutes: 7 }] },
      { ...option, vehicleId: "taxi-1" },
    ],
    rejected: [],
    elapsedMs: 730,
    straightLine: true,
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  actions.findPlaces.mockResolvedValue({ ok: true, view: places() });
  actions.placeTrip.mockResolvedValue({ ok: true, message: "Course placée." });
});

function renderFinder(props: { blocked?: string | null; autoStart?: boolean; vehicleId?: string | null; onAutoStarted?: () => void } = {}) {
  const { trips, vehicles } = planningFixture();
  const trip = { ...trips["trip-c"]!, vehicleId: props.vehicleId ?? null };
  render(
    <PlanningActivityProvider timeLimitSec={10}>
      <PlaceFinder
        trip={trip}
        trips={trips}
        vehicles={vehicles}
        blocked={props.blocked ?? null}
        autoStart={props.autoStart}
        onAutoStarted={props.onAutoStarted}
      />
    </PlanningActivityProvider>,
  );
}

describe("PlaceFinder (« Où placer cette course ? »)", () => {
  it("searches on demand, then lists the places by depot, best first, with what each changes", async () => {
    renderFinder();
    expect(actions.findPlaces).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Chercher" }));
    await waitFor(() => expect(actions.findPlaces).toHaveBeenCalledWith("trip-c"));
    const list = await screen.findByRole("list", { name: "Places par dépôt" });
    // Counted as listed: the VSL off the road that day, greyed below, is one of the compatible vehicles.
    expect(screen.getByText(plain("2 places possibles sur 3 véhicules compatibles · calcul 0,7\u00a0s · distances à vol d'oiseau"))).toBeTruthy();
    const depots = within(list).getAllByRole("listitem").filter((li) => li.parentElement === list);
    expect(depots.map((d) => d.querySelector("p span")?.textContent)).toEqual(["Marseille", "Manosque"]);
    const best = within(depots[0]!).getAllByRole("listitem")[0]!;
    expect(best.textContent).toContain("VSL 1 (Marseille)");
    expect(best.textContent).toContain("marge\u00a0+21\u00a0€");
    expect(best.textContent).toContain("Meilleure place");
    expect(best.textContent).toContain("prise en charge 07:00 · dépose 07:25");
    expect(best.textContent).toContain("+4,2\u00a0km dont +1,1\u00a0km à vide · +15\u00a0min de service · CA\u00a0+18\u00a0€");
    expect(best.textContent).toContain("Partagée avec Monique Aubert");
    expect(best.textContent).toContain("Décale Monique Aubert de +7\u00a0min");
    // The VSL off the road that day, greyed with its reason.
    expect(depots[1]!.textContent).toContain("aucune place");
    expect(within(depots[1]!).getByText("1 véhicule sans place")).toBeTruthy();
    expect(depots[1]!.textContent).toContain("VSL 2 (Manosque) est indisponible ce jour\u00a0: révision au garage");
    expect(screen.getByRole("button", { name: "Recalculer" })).toBeTruthy();
  });

  it("applies a place on the version it was computed on, and asks first on a validated day", async () => {
    renderFinder();
    fireEvent.click(screen.getByRole("button", { name: "Chercher" }));
    const apply = await screen.findByRole("button", { name: "Appliquer\u00a0: placer la course sur VSL 1 (Marseille)" });
    actions.placeTrip.mockResolvedValueOnce({ ok: false, needsConfirmation: true, error: QUESTION });
    fireEvent.click(apply);
    await waitFor(() => expect(actions.placeTrip).toHaveBeenCalledWith("trip-c", "vsl-1", "v-42", null));
    expect(await screen.findByText(plain(QUESTION))).toBeTruthy();
    // Labelled « En cours… » until the action's transition ends (the question is set inside it).
    fireEvent.click(await screen.findByRole("button", { name: "Oui, appliquer" }));
    await waitFor(() => expect(actions.placeTrip).toHaveBeenLastCalledWith("trip-c", "vsl-1", "v-42", QUESTION));
  });

  it("drops the places once the plan changed, and says why a search failed", async () => {
    renderFinder();
    fireEvent.click(screen.getByRole("button", { name: "Chercher" }));
    const apply = await screen.findByRole("button", { name: "Appliquer\u00a0: placer la course sur Taxi 1 (Marseille)" });
    actions.placeTrip.mockResolvedValueOnce({ ok: false, stale: true, error: "Le planning a changé." });
    fireEvent.click(apply);
    await waitFor(() => expect(screen.queryByRole("list", { name: "Places par dépôt" })).toBeNull());
    actions.findPlaces.mockResolvedValueOnce({ ok: false, error: "Le service d'optimisation ne répond pas." });
    fireEvent.click(screen.getByRole("button", { name: "Chercher" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Le service d'optimisation ne répond pas.");
  });

  it("says why it cannot search, and searches at once when asked to", async () => {
    const onAutoStarted = vi.fn();
    renderFinder({ blocked: "Course annulée.", autoStart: true, onAutoStarted });
    expect((screen.getByRole("button", { name: "Chercher" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Course annulée.")).toBeTruthy();
    expect(actions.findPlaces).not.toHaveBeenCalled();
    expect(onAutoStarted).not.toHaveBeenCalled();
    cleanup();
    renderFinder({ autoStart: true, onAutoStarted });
    await waitFor(() => expect(actions.findPlaces).toHaveBeenCalledTimes(1));
    // The request is spent: the board stops asking (a remount after « Appliquer » does not search again).
    expect(onAutoStarted).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("list", { name: "Places par dépôt" })).toBeTruthy();
  });

  it("never marks a move that loses money as the best place: the trip's own place stays better", async () => {
    const losing = places({
      fromVehicleId: "taxi-1",
      options: places().options.map((o, i) => ({ ...o, deltaMargin: -13.4 - i * 10 })),
    });
    actions.findPlaces.mockResolvedValueOnce({ ok: true, view: losing });
    renderFinder({ vehicleId: "taxi-1" });
    fireEvent.click(screen.getByRole("button", { name: "Chercher" }));
    expect(await screen.findByText(plain("Sa place actuelle reste la plus rentable\u00a0: chaque déplacement coûte au moins 13\u00a0€."))).toBeTruthy();
    expect(screen.queryByText("Meilleure place")).toBeNull();
    // No primary « Appliquer » either: each is a plain choice.
    for (const button of screen.getAllByRole("button", { name: /^Appliquer/ })) expect(button.className).not.toContain("bg-brand-700");
  });

  it("keeps the focus on « Chercher » while it searches, and announces only the headline", async () => {
    let answer: (value: unknown) => void = () => {};
    actions.findPlaces.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    renderFinder();
    const button = screen.getByRole("button", { name: "Chercher" }) as HTMLButtonElement;
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    // A second click while it searches is ignored.
    fireEvent.click(button);
    expect(actions.findPlaces).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Recherche des places…");
    answer({ ok: true, view: places() });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2 places possibles sur 3 véhicules compatibles"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Recalculer" }));
    // The list itself is not a live region (a screen reader would read all of it at each search).
    expect(screen.getByRole("list", { name: "Places par dépôt" }).closest("[aria-live]")).toBeNull();
  });

  it("shows the depots' other places and vehicles without a place behind a disclosure", async () => {
    const { vehicles } = planningFixture();
    const many = places({
      options: ["taxi-1", "vsl-1", "amb-x", "taxi-y"].map((vehicleId, i) => ({ ...places().options[1]!, vehicleId, deltaMargin: 10 - i })),
      rejected: [{ vehicleId: "vsl-2", kind: "SHIFT", reason: "ne peut pas l'assurer dans ses heures de service (13:00–19:00)" }],
    });
    actions.findPlaces.mockResolvedValueOnce({ ok: true, view: many });
    render(
      <PlanningActivityProvider timeLimitSec={10}>
        <PlaceFinder
          trip={{ id: "trip-c", vehicleId: null, allowedVehicleTypes: ["TAXI", "VSL", "AMBULANCE"] }}
          trips={{}}
          vehicles={[
            ...vehicles,
            { ...vehicles[0]!, id: "amb-x", label: "Ambulance X", type: "AMBULANCE" },
            { ...vehicles[0]!, id: "taxi-y", label: "Taxi Y" },
          ]}
          blocked={null}
        />
      </PlanningActivityProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Chercher" }));
    expect(await screen.findByText("1 autre place")).toBeTruthy();
    expect(screen.getByText(/VSL 2 \(Manosque\)/).closest("details")).toBeTruthy();
  });
});
