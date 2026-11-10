// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionButton } from "./action-button";
import { ConfirmAction } from "./confirm-action";
import { successState, type ActionResult, type FormState } from "@/lib/forms";

afterEach(cleanup);

describe("ConfirmAction", () => {
  it("asks first, with a red button that repeats the action and a button that says what is kept", async () => {
    const action = vi.fn(async (): Promise<FormState> => successState("Véhicule désactivé."));
    render(
      <ConfirmAction
        action={action}
        label="Désactiver le véhicule"
        confirmLabel="Oui, désactiver le véhicule"
        keepLabel="Garder le véhicule actif"
        question={<p>Le véhicule ne sera plus proposé à l&apos;optimisation.</p>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Désactiver le véhicule" }));
    const panel = screen.getByRole("group", { name: "Le véhicule ne sera plus proposé à l'optimisation." });
    const confirm = screen.getByRole("button", { name: "Oui, désactiver le véhicule" });
    expect(confirm.className).toContain("bg-red-600");
    expect(document.activeElement).toBe(confirm);
    expect(panel.textContent).toContain("Garder le véhicule actif");
    expect(action).not.toHaveBeenCalled();
  });

  it("gives the focus back to the first button when the question is kept, or with Échap", () => {
    render(
      <ConfirmAction action={vi.fn()} label="Supprimer" confirmLabel="Oui, supprimer le plein" keepLabel="Garder le plein" question="Supprimer ce plein&#x202F;?" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Supprimer" }));
    fireEvent.click(screen.getByRole("button", { name: "Garder le plein" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Supprimer" }));
    fireEvent.click(screen.getByRole("button", { name: "Supprimer" }));
    fireEvent.keyDown(screen.getByRole("group", { name: "Supprimer ce plein\u202f?" }), { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Supprimer" }));
  });
});

describe("ActionButton", () => {
  it("runs a confirmed action and says what it did, the focus back on its button", async () => {
    const action = vi.fn<(prev: ActionResult, data: FormData) => Promise<ActionResult>>(async () => ({ ok: true, message: "Patient désactivé." }));
    render(
      <ActionButton
        action={action}
        fields={{ patientId: "p1", active: "false" }}
        confirm={{ question: "Désactiver DURAND Marie\u202f?", confirmLabel: "Oui, désactiver le patient", keepLabel: "Garder le patient actif" }}
      >
        Désactiver
      </ActionButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Désactiver" }));
    expect(action).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Oui, désactiver le patient" }));
    });
    expect(action).toHaveBeenCalledTimes(1);
    const data = action.mock.calls[0]?.[1];
    expect(data?.get("patientId")).toBe("p1");
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Patient désactivé.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Désactiver" }));
  });

  it("submits at once without a question", async () => {
    const action = vi.fn(async (): Promise<ActionResult> => ({ ok: false, message: "Refusé." }));
    render(
      <ActionButton action={action} fields={{ id: "x" }}>
        Réactiver
      </ActionButton>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Réactiver" }));
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("alert")).textContent).toBe("Refusé.");
  });
});
