// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftView } from "@/lib/planning/draft";
import { DraftBar, draftSummary } from "./draft-bar";
import { PlanningActivityProvider } from "./planning-activity";
import type { PlanningDraft } from "./use-planning-draft";

vi.mock("./actions", () => ({}));

afterEach(cleanup);

const figures = (served: number, margin: number, km: number) => ({ served, violations: 0, revenue: 1000, margin, km });

function view(overrides: Partial<DraftView> = {}): DraftView {
  return {
    version: "v-1",
    moves: [
      { tripId: "trip-a", toVehicleId: "vsl-1", fromVehicleId: "taxi-1", ok: true, pickupMinute: 552, dropoffMinute: 580, deltaKm: -3, deltaMargin: 18 },
      { tripId: "trip-c", toVehicleId: null, fromVehicleId: "taxi-1", ok: true, pickupMinute: null, dropoffMinute: null, deltaKm: null, deltaMargin: null },
    ],
    routes: [],
    trips: [],
    before: figures(10, 400, 300),
    after: figures(9, 445.4, 288),
    newViolations: [],
    shifted: [{ tripId: "trip-b", vehicleId: "vsl-1", fromPickupMinute: 600, toPickupMinute: 615 }],
    question: null,
    ...overrides,
  };
}

function draft(overrides: Partial<PlanningDraft> = {}): PlanningDraft {
  return {
    moves: [
      { tripId: "trip-a", toVehicleId: "vsl-1" },
      { tripId: "trip-c", toVehicleId: null },
    ],
    view: view(),
    checking: false,
    refusal: null,
    question: null,
    drop: vi.fn(),
    remove: vi.fn(),
    cancel: vi.fn(),
    save: vi.fn(),
    retry: vi.fn(),
    dismissRefusal: vi.fn(),
    dismissQuestion: vi.fn(),
    ...overrides,
  };
}

const names: Record<string, string> = { "trip-a": "AUBERT Monique (aller, RDV 09:30)", "trip-b": "BLANC Gérard", "trip-c": "IMBERT Colette" };
const labels: Record<string, string> = { "taxi-1": "Taxi 1", "vsl-1": "VSL 1" };

function renderBar(value: PlanningDraft, onShowTrip = vi.fn()) {
  render(
    <PlanningActivityProvider timeLimitSec={10}>
      <DraftBar draft={value} nameOf={(id) => names[id] ?? id} vehicleLabel={(id) => labels[id] ?? id} onShowTrip={onShowTrip} />
    </PlanningActivityProvider>,
  );
  return { onShowTrip };
}

describe("draftSummary", () => {
  it("says what the draft changes in the day", () => {
    expect(draftSummary(view())).toBe(
      "marge +45 € · −12,0 km · −1 course servie · aucune violation nouvelle · 1 autre patient décalé de 10 min ou plus",
    );
    expect(draftSummary(view({ after: figures(10, 400, 300), shifted: [], newViolations: [{ code: "TOTAL_WAIT", message: "", tripId: null, vehicleId: null }] }))).toBe(
      "marge inchangée · 0 km · 1 violation nouvelle",
    );
  });
});

describe("DraftBar", () => {
  it("shows nothing without a move nor a refusal", () => {
    renderBar(draft({ moves: [], view: null }));
    expect(screen.queryByRole("region", { name: "Brouillon de la frise" })).toBeNull();
  });

  it("counts the moves not saved, with what they change; « Annuler » and « Enregistrer »", () => {
    const value = draft();
    renderBar(value);
    const bar = screen.getByRole("region", { name: "Brouillon de la frise" });
    expect(bar.textContent).toContain("2 modifications non enregistrées");
    expect(bar.textContent).toContain("marge +45 €");
    fireEvent.click(within(bar).getByRole("button", { name: "Enregistrer" }));
    expect(value.save).toHaveBeenCalledWith(null);
  });

  it("asks before « Annuler » throws away two moves or more, not for one", () => {
    const value = draft();
    renderBar(value);
    const bar = screen.getByRole("region", { name: "Brouillon de la frise" });
    fireEvent.click(within(bar).getByRole("button", { name: "Annuler" }));
    expect(value.cancel).not.toHaveBeenCalled();
    expect(bar.textContent).toContain("Abandonner les 2 modifications non enregistrées");
    fireEvent.click(within(bar).getByRole("button", { name: "Garder le brouillon" }));
    expect(value.cancel).not.toHaveBeenCalled();
    expect(within(bar).getByRole("button", { name: "Annuler" })).toBe(document.activeElement);
    fireEvent.click(within(bar).getByRole("button", { name: "Annuler" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Oui, abandonner le brouillon" }));
    expect(value.cancel).toHaveBeenCalledTimes(1);
    cleanup();
    const one = draft({ moves: [{ tripId: "trip-a", toVehicleId: "vsl-1" }] });
    renderBar(one);
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(one.cancel).toHaveBeenCalled();
  });

  it("offers « Vérifier de nouveau », not « Enregistrer », for a draft whose check did not answer", () => {
    const value = draft({ view: null, refusal: "Le service d'optimisation ne répond pas." });
    renderBar(value);
    expect(screen.queryByRole("button", { name: "Enregistrer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Vérifier de nouveau" }));
    expect(value.retry).toHaveBeenCalled();
  });

  it("lists each move in « Détail », with the patients it delays; a move can be removed, a trip shown", () => {
    const value = draft();
    const { onShowTrip } = renderBar(value);
    fireEvent.click(screen.getByRole("button", { name: "Détail" }));
    const bar = screen.getByRole("region", { name: "Brouillon de la frise" });
    expect(bar.textContent).toContain("Taxi 1 → VSL 1 · prise en charge 09:12 · marge +18 €");
    expect(bar.textContent).toContain("Taxi 1 → À placer");
    expect(bar.textContent).toContain("BLANC Gérard (VSL 1) : 10:00 → 10:15");
    fireEvent.click(within(bar).getByRole("button", { name: "Retirer du brouillon le déplacement de IMBERT Colette" }));
    expect(value.remove).toHaveBeenCalledWith("trip-c");
    fireEvent.click(within(bar).getByRole("button", { name: "AUBERT Monique (aller, RDV 09:30)" }));
    expect(onShowTrip).toHaveBeenCalledWith("trip-a");
  });

  it("cannot save while the draft is checked, says why a drop was refused, and asks first on a validated day", () => {
    renderBar(draft({ checking: true }));
    expect((screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("region", { name: "Brouillon de la frise" }).textContent).toContain("vérification par l'optimiseur");
    cleanup();
    const refused = draft({ moves: [], view: null, refusal: "Déplacement refusé pour la course de IMBERT Colette : VSL 1 est en pause." });
    renderBar(refused);
    expect(screen.getByRole("alert").textContent).toContain("VSL 1 est en pause.");
    fireEvent.click(screen.getByRole("button", { name: "Fermer le message" }));
    expect(refused.dismissRefusal).toHaveBeenCalled();
    cleanup();
    const asked = draft({ question: "Planning validé : … Appliquer quand même ?" });
    renderBar(asked);
    fireEvent.click(screen.getByRole("button", { name: "Oui, enregistrer" }));
    expect(asked.save).toHaveBeenCalledWith("Planning validé : … Appliquer quand même ?");
  });
});
