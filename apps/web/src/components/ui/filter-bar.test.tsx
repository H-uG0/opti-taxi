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

function Bar({ mode, filtered = false }: { mode?: "navigate" | "replace"; filtered?: boolean }) {
  return (
    <FilterBar action="/vehicules" label="Filtrer les véhicules" resetHref="/vehicules" filtered={filtered} mode={mode} hidden={{ date: "2026-11-11" }}>
      <FilterSearch defaultValue="" placeholder="Libellé" />
      <FilterSelect name="type" label="Type" value="" allLabel="Tous" options={[{ value: "TAXI", label: "Taxi" }]} />
      <FilterSelect
        name="statut"
        label="Statut"
        value="actifs"
        defaultChoice="actifs"
        options={[
          { value: "actifs", label: "Actifs" },
          { value: "tous", label: "Tous" },
        ]}
      />
      <FilterCheckbox name="etat" value="a-traiter" label="À traiter seulement" checked={false} />
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
