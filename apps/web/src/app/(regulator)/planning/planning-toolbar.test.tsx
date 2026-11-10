// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

afterEach(cleanup);
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
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Valider quand même ?");
    expect(actions.validateDay).toHaveBeenLastCalledWith("2026-11-10", null, "v-1");
    // The confirmation takes the focus.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Valider quand même"));
    fireEvent.click(screen.getByRole("button", { name: "Valider quand même" }));
    await waitFor(() => expect(actions.validateDay).toHaveBeenLastCalledWith("2026-11-10", CONFIRM, "v-1"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("closes the question with « Annuler » or Escape without validating, the focus back on « Valider le planning »", async () => {
    renderToolbar();
    const validateButton = screen.getByRole("button", { name: /Valider le planning/ });
    fireEvent.click(validateButton);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Valider quand même"));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(validateButton);
    fireEvent.click(validateButton);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Valider quand même"));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(validateButton);
    expect(actions.validateDay).toHaveBeenCalledTimes(2);
  });

  it("offers « Rouvrir » on a validated day instead of « Valider »", async () => {
    renderToolbar({ canValidate: false, canReopen: true });
    expect(screen.queryByRole("button", { name: /Valider le planning/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Rouvrir/ }));
    await waitFor(() => expect(actions.reopenDay).toHaveBeenCalledWith("2026-11-10"));
  });
});
