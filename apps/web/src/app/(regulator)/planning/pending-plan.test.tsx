// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunView } from "@/lib/planning/types";
import { PendingPlanBanner } from "./pending-plan";
import { PlanningActivityProvider, useTripLink } from "./planning-activity";

const actions = vi.hoisted(() => ({
  confirmPlan: vi.fn(async () => ({ ok: true, message: "Nouveau planning enregistré." })),
  discardPlan: vi.fn(async () => ({ ok: true, message: "Calcul écarté." })),
  previewPlanSelection: vi.fn(),
  restorePlan: vi.fn(),
}));
vi.mock("./actions", () => actions);

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const figures = (served: number, margin: number) => ({ served, violations: 0, revenue: 1200, margin, km: 400 });

function reviewRun(overrides: Partial<NonNullable<RunView["pending"]>> = {}): RunView & { pending: NonNullable<RunView["pending"]> } {
  return {
    id: "run-p",
    status: "AWAITING_CONFIRMATION",
    startedAt: "2026-11-10T10:42:00.000Z",
    finishedAt: "2026-11-10T10:42:12.000Z",
    durationMs: 12000,
    wallTimeMs: 10000,
    matrixSource: "haversine",
    trafficSource: "none",
    valid: true,
    error: null,
    tripsCount: 64,
    lockedCount: 0,
    unassignedCount: 1,
    requestedBy: "Régulation",
    warnings: [],
    timeLimitSec: 10,
    interrupted: false,
    kind: "optimize",
    previous: null,
    evaluatedAt: null,
    pending: {
      question: "Ce calcul change 2 courses du planning en place : 1 course change de véhicule, 1 course placée.",
      comparison: { current: figures(62, 1073), next: figures(63, 1208), lostTripIds: [] },
      lostTrips: [],
      violations: [],
      review: true,
      selectable: true,
      changes: {
        trips: [
          { tripId: "t1", kind: "vehicle", from: "taxi-1", to: "vsl-2", fromPickup: 450, toPickup: 470, trip: "MARTIN Jeanne (aller, RDV 08:30)", fromLabel: "Taxi 1", toLabel: "VSL 2" },
          { tripId: "t9", kind: "assigned", from: null, to: "vsl-2", fromPickup: null, toPickup: 600, trip: "DURAND Paul (retour, fin 10:00)", fromLabel: null, toLabel: "VSL 2" },
        ],
        routes: [
          { vehicleId: "vsl-2", label: "VSL 2", before: { trips: 3, km: 90, margin: 40 }, after: { trips: 5, km: 120, margin: 70 }, refusable: true, tripChanges: 2 },
          { vehicleId: "taxi-1", label: "Taxi 1", before: { trips: 4, km: 80, margin: 30 }, after: { trips: 3, km: 70, margin: 35 }, refusable: true, tripChanges: 1 },
          { vehicleId: "vsl-9", label: "VSL 9", before: { trips: 2, km: 50, margin: 10 }, after: null, refusable: false, tripChanges: 0 },
        ],
      },
      ...overrides,
    },
  };
}

function Listener({ onShow }: { onShow: (tripId: string) => void }) {
  const { subscribe } = useTripLink();
  useEffect(() => subscribe(onShow), [subscribe, onShow]);
  return null;
}

function renderBanner(run = reviewRun(), onShow = vi.fn()) {
  render(
    <PlanningActivityProvider timeLimitSec={10}>
      <Listener onShow={onShow} />
      <PendingPlanBanner run={run} />
    </PlanningActivityProvider>,
  );
  return { onShow, banner: screen.getByRole("alertdialog") };
}

describe("PendingPlanBanner, a re-optimization held for review (INS-02)", () => {
  it("says it is not saved yet, with the figures side by side and the « Changements » grouped", () => {
    const { banner } = renderBanner();
    expect(banner.textContent).toContain("n'est pas encore enregistré : vérifiez ce qu'il change");
    expect(banner.textContent).toContain("Changements (2)");
    const vehicle = within(banner).getByRole("region", { name: "Changent de véhicule" });
    expect(vehicle.textContent).toContain("MARTIN Jeanne (aller, RDV 08:30)Taxi 1 → VSL 2 · prise en charge 07:30 → 07:50");
    expect(within(banner).getByRole("region", { name: "Nouvellement placées" }).textContent).toContain("→ VSL 2 · prise en charge 10:00");
    expect(within(banner).getByRole("button", { name: "Tout accepter" })).toBeTruthy();
  });

  it("shows a trip of the list on the board", () => {
    const { banner, onShow } = renderBanner();
    fireEvent.click(within(banner).getByRole("button", { name: "MARTIN Jeanne (aller, RDV 08:30)" }));
    expect(onShow).toHaveBeenCalledWith("t1");
  });

  it("« Tout accepter » saves the whole plan, « Garder le planning actuel » drops it", async () => {
    const { banner } = renderBanner();
    fireEvent.click(within(banner).getByRole("button", { name: "Tout accepter" }));
    await waitFor(() => expect(actions.confirmPlan).toHaveBeenCalledWith("run-p"));
    // One action at a time: the buttons come back once it answered.
    const keep = within(banner).getByRole("button", { name: "Garder le planning actuel" }) as HTMLButtonElement;
    await waitFor(() => expect(keep.disabled).toBe(false));
    fireEvent.click(keep);
    await waitFor(() => expect(actions.discardPlan).toHaveBeenCalledWith("run-p"));
  });

  it("checks a selection with the optimizer before saving it: the refused vehicles keep their route", async () => {
    actions.previewPlanSelection.mockResolvedValue({
      ok: true,
      preview: {
        key: "key-1",
        current: figures(62, 1073),
        next: figures(63, 1208),
        selection: figures(61, 1100),
        refused: ["Taxi 1"],
        keptOnRefused: [],
        leftOut: ["MARTIN Jeanne (aller, RDV 08:30) (sur Taxi 1 actuellement, sur VSL 2 dans le calcul)"],
        violations: [],
        question: "Cette sélection sert 61 courses contre 62 dans le planning actuel : remplacer quand même ?",
        hint: "Pour qu'elle garde un véhicule, décochez VSL 2.",
      },
    });
    const { banner } = renderBanner();
    // A vehicle off the road today cannot keep its route.
    expect((within(banner).getByRole("checkbox", { name: /VSL 9/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(banner).getByRole("checkbox", { name: /^Taxi 1/ }));
    expect(banner.textContent).toContain("1 véhicule garde sa tournée");
    await act(async () => {
      fireEvent.click(within(banner).getByRole("button", { name: "Vérifier la sélection" }));
    });
    expect(actions.previewPlanSelection).toHaveBeenCalledWith("run-p", ["taxi-1"]);
    expect(banner.textContent).toContain("Sélection vérifiée par l'optimiseur (Taxi 1 garde sa tournée)");
    expect(banner.textContent).toContain("Pour qu'elle garde un véhicule, décochez VSL 2.");
    expect(within(banner).getByRole("columnheader", { name: "Sélection" })).toBeTruthy();
    fireEvent.click(within(banner).getByRole("button", { name: "Enregistrer la sélection quand même" }));
    await waitFor(() => expect(actions.confirmPlan).toHaveBeenCalledWith("run-p", { refusedVehicleIds: ["taxi-1"], key: "key-1" }));
  });

  it("asks to check again once the selection changed, and keeps the old banner for a worse plan", () => {
    const { banner } = renderBanner(reviewRun({ selectable: false }));
    expect(within(banner).queryByText(/Accepter véhicule par véhicule/)).toBeNull();
    cleanup();
    const worse = reviewRun({
      review: false,
      selectable: false,
      changes: null,
      question: "Ce calcul sert 61 courses contre 62 dans le planning actuel : remplacer quand même ?",
      lostTrips: ["MARTIN Jeanne (aller, RDV 08:30)"],
      comparison: { current: figures(62, 1073), next: figures(61, 1100), lostTripIds: ["t1"] },
    });
    renderBanner(worse);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("n'a pas remplacé le planning en place");
    expect(within(dialog).getByRole("button", { name: "Remplacer quand même" })).toBeTruthy();
    expect(dialog.textContent).toContain("1 course servie actuellement resterait sans véhicule");
  });
});
