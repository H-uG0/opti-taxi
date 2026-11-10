// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planningFixture } from "@/test/planning-fixtures";
import { PlanningSearch } from "./planning-search";

afterEach(cleanup);

function renderSearch() {
  const { trips, vehicles } = planningFixture();
  const onSelectTrip = vi.fn();
  const onShowVehicle = vi.fn();
  render(
    <>
      <input aria-label="Autre champ" />
      <PlanningSearch trips={Object.values(trips)} vehicles={vehicles} onSelectTrip={onSelectTrip} onShowVehicle={onShowVehicle} />
    </>,
  );
  const input = screen.getByRole("combobox");
  return { input, onSelectTrip, onShowVehicle };
}

describe("PlanningSearch («\u202f/\u202f»)", () => {
  it("takes the focus on «\u202f/\u202f» from the page, never while typing elsewhere", () => {
    const { input } = renderSearch();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(input);

    const other = screen.getByLabelText("Autre champ");
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
  });

  it("lists the matches as options, moves with the arrows and chooses with Enter", () => {
    const { input, onSelectTrip, onShowVehicle } = renderSearch();
    fireEvent.change(input, { target: { value: "marseille" } });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Taxi 1 (Marseille)"),
      expect.stringContaining("VSL 1 (Marseille)"),
      expect.stringContaining("Ambulance 1 (Marseille)"),
    ]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onShowVehicle).toHaveBeenCalledWith("vsl-1");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(input, { target: { value: "aubert" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectTrip).toHaveBeenCalledWith("trip-a");
  });

  it("says when nothing matches, and Escape closes the list then clears the query", () => {
    const { input } = renderSearch();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByRole("option").textContent).toMatch(/^Aucun patient, véhicule, chauffeur ni établissement/);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("closes the list when the focus leaves it (Tab), and the list is no Tab stop", () => {
    const { input } = renderSearch();
    fireEvent.change(input, { target: { value: "marseille" } });
    expect(screen.getByRole("listbox").getAttribute("tabindex")).toBe("-1");
    const other = screen.getByLabelText("Autre champ");
    fireEvent.blur(input, { relatedTarget: other });
    expect(screen.queryByRole("listbox")).toBeNull();
    // Back in the field: the list shows again.
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("chooses with the pointer", () => {
    const { input, onSelectTrip } = renderSearch();
    fireEvent.change(input, { target: { value: "blanc" } });
    fireEvent.pointerDown(screen.getByRole("option", { name: /Gérard Blanc/ }));
    expect(onSelectTrip).toHaveBeenCalledWith("trip-b");
  });
});
