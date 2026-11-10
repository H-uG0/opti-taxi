// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar, FilterCheckbox, FilterSearch, FilterSelect } from "./filter-bar";

const router = vi.hoisted(() => ({ push: vi.fn() }));
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => search.params }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) =>
      React.createElement("a", { href, ...Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "replace" && key !== "scroll")) }, children),
  };
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  search.params = new URLSearchParams();
  window.history.replaceState(null, "", "/vehicules");
});

/** A list page: its filter parsed from the address (an old `inactifs=1` reads as « tous », an unknown type as none). */
function Bar({ mode, filtered = false }: { mode?: "navigate" | "replace"; filtered?: boolean }) {
  const params = search.params;
  const type = params.get("type") === "TAXI" ? "TAXI" : "";
  const status = params.get("statut") === "tous" || params.get("inactifs") === "1" ? "tous" : "actifs";
  return (
    <FilterBar action="/vehicules" label="Filtrer les véhicules" resetHref="/vehicules" filtered={filtered} mode={mode} hidden={{ date: "2026-11-11" }}>
      <FilterSearch defaultValue={params.get("q")?.trim() ?? ""} placeholder="Libellé" />
      <FilterSelect name="type" label="Type" value={type} allLabel="Tous" options={[{ value: "TAXI", label: "Taxi" }]} />
      <FilterSelect
        name="statut"
        label="Statut"
        value={status}
        defaultChoice="actifs"
        options={[
          { value: "actifs", label: "Actifs" },
          { value: "tous", label: "Tous" },
        ]}
        className="w-32"
      />
      <FilterCheckbox name="etat" value="a-traiter" label="À traiter seulement" checked={params.get("etat") === "a-traiter"} />
    </FilterBar>
  );
}

describe("FilterBar (navigate)", () => {
  it("applies a choice at once, leaving empty and default values out of the address", () => {
    render(<Bar />);
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "TAXI" } });
    expect(router.push).toHaveBeenLastCalledWith("/vehicules?date=2026-11-11&type=TAXI", { scroll: false });
    fireEvent.click(screen.getByLabelText("À traiter seulement"));
    expect(router.push).toHaveBeenLastCalledWith("/vehicules?date=2026-11-11&type=TAXI&etat=a-traiter", { scroll: false });
  });

  it("applies the search field on « Filtrer » only", () => {
    render(<Bar />);
    fireEvent.change(screen.getByLabelText("Rechercher"), { target: { value: " taxi 12 " } });
    expect(router.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Filtrer" }));
    expect(router.push).toHaveBeenLastCalledWith("/vehicules?date=2026-11-11&q=taxi+12", { scroll: false });
  });

  it("offers « Réinitialiser » once filtered, and the fields follow the address", () => {
    const { rerender } = render(<Bar />);
    expect(screen.queryByRole("link", { name: "Réinitialiser" })).toBeNull();
    search.params = new URLSearchParams("type=TAXI&statut=tous&q=gap");
    rerender(<Bar filtered />);
    expect(screen.getByRole("link", { name: "Réinitialiser" }).getAttribute("href")).toBe("/vehicules");
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("TAXI");
    expect((screen.getByLabelText("Statut") as HTMLSelectElement).value).toBe("tous");
    expect((screen.getByLabelText("Rechercher") as HTMLInputElement).value).toBe("gap");
    // Back to the bare address: each field shows its default.
    search.params = new URLSearchParams();
    rerender(<Bar />);
    expect((screen.getByLabelText("Statut") as HTMLSelectElement).value).toBe("actifs");
    expect((screen.getByLabelText("Rechercher") as HTMLInputElement).value).toBe("");
  });

  it("shows the filter the page applies, not the raw address", () => {
    const { rerender } = render(<Bar />);
    // An old address (?inactifs=1) the page reads as « tous », and a type it does not know.
    search.params = new URLSearchParams("inactifs=1&type=BUS&etat=a-traiter&q=%20gap%20");
    rerender(<Bar filtered />);
    expect((screen.getByLabelText("Statut") as HTMLSelectElement).value).toBe("tous");
    expect((screen.getByLabelText("Type") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("À traiter seulement") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Rechercher") as HTMLInputElement).value).toBe("gap");
  });

  it("applies a list browsed with the arrow keys once the keys stop", () => {
    vi.useFakeTimers();
    render(<Bar />);
    const type = screen.getByLabelText("Type");
    fireEvent.keyDown(type, { key: "ArrowDown" });
    fireEvent.change(type, { target: { value: "TAXI" } });
    fireEvent.keyDown(type, { key: "ArrowUp" });
    fireEvent.change(type, { target: { value: "" } });
    fireEvent.keyDown(type, { key: "ArrowDown" });
    fireEvent.change(type, { target: { value: "TAXI" } });
    expect(router.push).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(450));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/vehicules?date=2026-11-11&type=TAXI", { scroll: false });
  });

  it("gives a field the width asked for instead of the default", () => {
    render(<Bar />);
    expect(screen.getByLabelText("Statut").parentElement?.className).toBe("space-y-1 w-32");
    expect(screen.getByLabelText("Type").parentElement?.className).toBe("space-y-1 w-44");
  });
});

describe("FilterBar (replace)", () => {
  it("rewrites the address in place, the search as you type", () => {
    vi.useFakeTimers();
    const replace = vi.spyOn(window.history, "replaceState");
    render(<Bar mode="replace" filtered />);
    expect(screen.queryByRole("button", { name: "Filtrer" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "TAXI" } });
    expect(replace).toHaveBeenLastCalledWith(null, "", "/vehicules?date=2026-11-11&type=TAXI");
    fireEvent.change(screen.getByLabelText("Rechercher"), { target: { value: "gap" } });
    act(() => vi.advanceTimersByTime(200));
    expect(replace).toHaveBeenLastCalledWith(null, "", "/vehicules?date=2026-11-11&q=gap&type=TAXI");
    fireEvent.click(screen.getByRole("link", { name: "Réinitialiser" }));
    expect(replace).toHaveBeenLastCalledWith(null, "", "/vehicules");
    expect(router.push).not.toHaveBeenCalled();
  });
});
