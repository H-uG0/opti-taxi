// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningActivityBanner, PlanningActivityProvider } from "./planning-activity";
import { PlanningToolbar, type ToolbarProps } from "./planning-toolbar";

const CONFIRM = "2 tournées ont un véhicule à revoir (Taxi 1 : contrôle technique dépassé). Valider quand même ?";

const actions = vi.hoisted(() => ({
  optimizeDay: vi.fn(async () => ({ ok: true, message: "10 tournées enregistrées." })),
  validateDay: vi.fn(async (_date: string, confirmed: string | null) =>
    confirmed ? { ok: true, message: "Planning validé." } : { ok: false, error: CONFIRM, needsConfirmation: true },
  ),
  reopenDay: vi.fn(async () => ({ ok: true, message: "Planning rouvert." })),
  placeUnassigned: vi.fn(async () => ({ ok: true, message: "2 courses placées sur 3 non affectées." })),
}));
vi.mock("./actions", () => actions);
// The toast's « Recharger » uses the router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => vi.clearAllMocks());

function renderToolbar(props: Partial<ToolbarProps> = {}) {
  render(
    <PlanningActivityProvider timeLimitSec={10}>
      <PlanningActivityBanner />
      <PlanningToolbar
        date="2026-11-10"
        version="v-1"
        optimizeLabel="Optimiser demain"
        optimizeBlocked={null}
        runningReason={null}
        canValidate
        canReopen={false}
        {...props}
      />
    </PlanningActivityProvider>,
  );
}

describe("PlanningToolbar (barre d'outils)", () => {
  it("places the trips without a vehicle on a planned day, with the same reasons to wait as optimizing", async () => {
    renderToolbar({ unassignedCount: 3 });
    const place = screen.getByRole("button", { name: /Placer les non affectées/ });
    expect(place.textContent).toContain("3");
    expect(place.getAttribute("title")).toMatch(/^Place les 3 courses non affectées dans les tournées en place/);
    fireEvent.click(place);
    await waitFor(() => expect(actions.placeUnassigned).toHaveBeenCalledWith("2026-11-10"));
    // The result shows in the toast.
    expect(await screen.findByText("2 courses placées sur 3 non affectées.")).toBeTruthy();
    cleanup();

    renderToolbar({ unassignedCount: 3, optimizeBlocked: "Planning validé : rouvrez-le pour le modifier." });
    expect((screen.getByRole("button", { name: /Placer les non affectées/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    renderToolbar({ unassignedCount: 0 });
    expect(screen.queryByRole("button", { name: /Placer les non affectées/ })).toBeNull();
  });

  it("optimizes the date", async () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: /Optimiser demain/ }));
    await waitFor(() => expect(actions.optimizeDay).toHaveBeenCalledWith("2026-11-10"));
  });

  it("disables the buttons with the reason while a computation runs elsewhere", () => {
    renderToolbar({ runningReason: "Une optimisation de cette date est en cours : attendez la fin du calcul." });
    const optimize = screen.getByRole("button", { name: /Optimiser demain/ }) as HTMLButtonElement;
    expect(optimize.disabled).toBe(true);
    expect(optimize.title).toContain("en cours");
    expect((screen.getByRole("button", { name: /Valider le planning/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before validating when the server says so, then validates with the question answered", async () => {
    renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: /Valider le planning/ }));
    const dialog = await screen.findByRole("group", { name: CONFIRM });
    expect(dialog.textContent).toContain("Valider quand même ?");
    expect(actions.validateDay).toHaveBeenLastCalledWith("2026-11-10", null, "v-1");
    // The confirmation takes the focus.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Oui, valider quand même"));
    fireEvent.click(screen.getByRole("button", { name: "Oui, valider quand même" }));
    await waitFor(() => expect(actions.validateDay).toHaveBeenLastCalledWith("2026-11-10", CONFIRM, "v-1"));
    await waitFor(() => expect(screen.queryByRole("group", { name: CONFIRM })).toBeNull());
  });

  it("closes the question with « Revoir le planning » or Escape without validating, the focus back on « Valider le planning »", async () => {
    renderToolbar();
    const validateButton = screen.getByRole("button", { name: /Valider le planning/ });
    fireEvent.click(validateButton);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Oui, valider quand même"));
    fireEvent.click(screen.getByRole("button", { name: "Revoir le planning" }));
    expect(screen.queryByRole("group", { name: CONFIRM })).toBeNull();
    expect(document.activeElement).toBe(validateButton);
    fireEvent.click(validateButton);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Oui, valider quand même"));
    fireEvent.keyDown(screen.getByRole("group", { name: CONFIRM }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: CONFIRM })).toBeNull();
    expect(document.activeElement).toBe(validateButton);
    expect(actions.validateDay).toHaveBeenCalledTimes(2);
  });

  it("keeps a computation's result and anything left to look at until closed; a short confirmation goes by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderToolbar({ canValidate: false, canReopen: true });
    fireEvent.click(screen.getByRole("button", { name: /Optimiser demain/ }));
    expect(await screen.findByText("10 tournées enregistrées.")).toBeTruthy();
    // The toast's effects (its timer, if any) run before the clock moves.
    await act(async () => {});
    act(() => vi.advanceTimersByTime(60_000));
    // Run while the regulator may have looked away: still there.
    expect(screen.getByText("10 tournées enregistrées.")).toBeTruthy();

    actions.placeUnassigned.mockResolvedValueOnce({ ok: true, message: "Aucune des 2 courses non affectées n'a trouvé de place.", warning: true } as never);
    cleanup();
    renderToolbar({ unassignedCount: 2 });
    fireEvent.click(screen.getByRole("button", { name: /Placer les non affectées/ }));
    const warning = await screen.findByText("Aucune des 2 courses non affectées n'a trouvé de place.");
    // Amber, not the green of a success.
    expect(warning.closest("[role='status']")?.className).toContain("bg-amber-50");

    cleanup();
    renderToolbar({ canValidate: false, canReopen: true });
    fireEvent.click(screen.getByRole("button", { name: /Rouvrir/ }));
    expect(await screen.findByText("Planning rouvert.")).toBeTruthy();
    await act(async () => {});
    act(() => vi.advanceTimersByTime(13_000));
    await waitFor(() => expect(screen.queryByText("Planning rouvert.")).toBeNull());
  });

  it("offers « Rouvrir » on a validated day instead of « Valider »", async () => {
    renderToolbar({ canValidate: false, canReopen: true });
    expect(screen.queryByRole("button", { name: /Valider le planning/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Rouvrir/ }));
    await waitFor(() => expect(actions.reopenDay).toHaveBeenCalledWith("2026-11-10"));
  });
});
