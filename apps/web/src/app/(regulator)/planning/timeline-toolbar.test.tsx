// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FILTER } from "@/lib/planning/filter";
import { TimelineToolbar } from "./timeline-toolbar";

afterEach(cleanup);

function renderToolbar(filter = EMPTY_FILTER) {
  const onChange = vi.fn();
  render(
    <TimelineToolbar
      search={<input aria-label="Rechercher" />}
      filter={filter}
      onChange={onChange}
      depots={[{ id: "d1", label: "Gap", count: 3 }]}
      shown={3}
      total={3}
      dayLocks={null}
      showReturnToCheck={false}
    />,
  );
  return { onChange };
}

describe("TimelineToolbar", () => {
  it("opens the help with «\u202f?\u202f» from anywhere: the legend and the shortcuts, closed by Escape", () => {
    renderToolbar();
    fireEvent.keyDown(document.body, { key: "?" });
    const help = screen.getByRole("dialog", { name: "Aide du planning" });
    expect(document.activeElement).toBe(help);
    expect(within(help).getByRole("list", { name: "Légende de la frise" })).toBeTruthy();
    const shortcuts = help.textContent ?? "";
    for (const text of ["Chercher un patient", "Jour précédent", "Jour suivant", "Figer ou défiger la course sélectionnée", "Où placer cette course", "Problème suivant"]) {
      expect(shortcuts).toContain(text);
    }
    expect(Array.from(help.querySelectorAll("kbd")).map((k) => k.textContent)).toEqual(
      expect.arrayContaining(["/", "[", "]", "F", "D", "N", "?", "↑", "↓", "Entrée"]),
    );
    fireEvent.keyDown(help, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open the help while typing, and opens it from its button", () => {
    renderToolbar();
    fireEvent.keyDown(screen.getByLabelText("Rechercher"), { key: "?" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Aide" }));
    expect(screen.getByRole("dialog", { name: "Aide du planning" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fermer l'aide" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the view (density, zoom, map) when the filters are reset", () => {
    const { onChange } = renderToolbar({ ...EMPTY_FILTER, depots: ["d1"], compact: true, zoom: "2h", mapSelectionOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "Réinitialiser les filtres" }));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER, compact: true, zoom: "2h", mapSelectionOnly: true });
  });
});
