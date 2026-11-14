// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterGroups, remoteStatusText, SearchSelect, type SearchSelectGroup, type SearchSelectOption } from "./search-select";

afterEach(cleanup);

const OPTIONS: (SearchSelectOption | SearchSelectGroup)[] = [
  { value: "", label: "— Aucun chauffeur —" },
  {
    label: "Libres — dépôt Gap",
    options: [
      { value: "ana", label: "BÉRARD Anaïs", hint: "Carte taxi" },
      { value: "bob", label: "MARTIN Bob", hint: "Carte taxi" },
    ],
  },
  { label: "Absents ou non qualifiés", options: [{ value: "sick", label: "DURAND Paul", hint: "absence le 11/11/2026", disabled: true }] },
];

function Picker({ onChange = () => {}, build = () => OPTIONS }: { onChange?: (v: string) => void; build?: () => typeof OPTIONS }) {
  const [value, setValue] = useState("bob");
  const names: Record<string, string> = { "": "— Aucun chauffeur —", ana: "BÉRARD Anaïs", bob: "MARTIN Bob" };
  return (
    <SearchSelect
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
      options={build}
      selectedLabel={names[value] ?? value}
      label="Chauffeur de Taxi 1"
    />
  );
}

describe("SearchSelect", () => {
  it("builds its options only once opened", () => {
    const build = vi.fn(() => OPTIONS);
    render(<Picker build={build} />);
    expect(build).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chauffeur de Taxi 1\u00a0: MARTIN Bob" }));
    expect(build).toHaveBeenCalled();
    const list = screen.getByRole("listbox", { name: "Chauffeur de Taxi 1" });
    expect(within(list).getByRole("group", { name: "Libres — dépôt Gap" })).toBeTruthy();
    expect(within(list).getByRole("option", { name: /MARTIN Bob/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  it("filters as you type, accents aside, and chooses with the keyboard", () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Chauffeur de Taxi 1/ }));
    const search = screen.getByRole("combobox");
    fireEvent.change(search, { target: { value: "anais" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["BÉRARD AnaïsCarte taxi"]);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option").id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("ana");
    expect(screen.queryByRole("listbox")).toBeNull();
    const button = screen.getByRole("button", { name: "Chauffeur de Taxi 1\u00a0: BÉRARD Anaïs" });
    expect(document.activeElement).toBe(button);
  });

  it("never chooses a disabled option, and closes on Escape", () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Chauffeur de Taxi 1/ }), { key: "ArrowDown" });
    const sick = screen.getByRole("option", { name: /DURAND Paul/ });
    expect(sick.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(sick);
    expect(onChange).not.toHaveBeenCalled();
    // ↓ from the last choice (the current one) wraps to the first, past the disabled one.
    const search = screen.getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /Aucun chauffeur/ }).id);
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: /MARTIN Bob/ }).id);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a group kept for the search only once something is typed", () => {
    const items = [...OPTIONS, { label: "Non qualifiés", searchOnly: true, options: [{ value: "x", label: "ROUX Léa", disabled: true }] }];
    expect(filterGroups(items, "").map((g) => g.label)).not.toContain("Non qualifiés");
    expect(filterGroups(items, "roux").map((g) => g.label)).toEqual(["Non qualifiés"]);
  });

  it("keeps the groups that still match and drops the others", () => {
    expect(filterGroups(OPTIONS, "durand").map((g) => [g.label, g.options.map((o) => o.value)])).toEqual([
      ["Absents ou non qualifiés", ["sick"]],
    ]);
    expect(filterGroups(OPTIONS, "")).toHaveLength(3);
    expect(filterGroups(OPTIONS, "zzz")).toEqual([]);
  });
});

describe("SearchSelect with a server search", () => {
  type Answer = { status: "ok" | "short"; options: SearchSelectOption[]; more?: boolean };

  function Remote({ search, onChange = () => {} }: { search: (q: string) => Promise<Answer>; onChange?: (v: string) => void }) {
    const [value, setValue] = useState("");
    return (
      <SearchSelect
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        search={search}
        searchHint="Tapez au moins 2 lettres."
        selectedLabel={value || "Choisissez un patient…"}
        label="Patient"
        emptyText="Aucun patient actif ne correspond."
      />
    );
  }

  async function typeAndWait(text: string) {
    fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
  }

  it("asks the server only once 2 characters are typed, and drops an answer that arrives late", async () => {
    vi.useFakeTimers();
    try {
      const pending: { query: string; resolve: (a: Answer) => void }[] = [];
      const search = vi.fn((query: string) => new Promise<Answer>((resolve) => pending.push({ query, resolve })));
      const onChange = vi.fn();
      render(<Remote search={search} onChange={onChange} />);
      fireEvent.click(screen.getByRole("button", { name: /Patient/ }));
      await act(async () => {
        vi.advanceTimersByTime(10);
      });
      expect(screen.getByText("Tapez au moins 2 lettres.")).toBeTruthy();

      await typeAndWait("h");
      expect(search).not.toHaveBeenCalled();

      await typeAndWait("ha");
      await typeAndWait("ham");
      expect(search.mock.calls.map((c) => c[0])).toEqual(["ha", "ham"]);
      // « ham » answers first, then the stale « ha »: only « ham » is listed.
      await act(async () => pending[1]!.resolve({ status: "ok", options: [{ value: "p1", label: "HAMIDI Chantal", hint: "13100 Aix" }] }));
      await act(async () =>
        pending[0]!.resolve({ status: "ok", options: [{ value: "p9", label: "HAAS Paul" }, { value: "p1", label: "HAMIDI Chantal" }] }),
      );
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["HAMIDI Chantal13100 Aix"]);
      expect(screen.getByText("1 résultat")).toBeTruthy();

      const field = screen.getByRole("combobox");
      fireEvent.keyDown(field, { key: "ArrowDown" });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onChange).toHaveBeenCalledWith("p1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when nothing matches, when more match than shown, and when the search failed", () => {
    expect(remoteStatusText({ status: "ok", options: [], more: false }, "hint", "Aucun patient actif ne correspond.")).toBe(
      "Aucun patient actif ne correspond.",
    );
    expect(remoteStatusText({ status: "ok", options: [1, 2], more: true }, "hint", "vide")).toBe(
      "2 résultats affichés, d'autres correspondent\u00a0: précisez la recherche.",
    );
    expect(remoteStatusText({ status: "error", options: [], more: false }, "hint", "vide")).toMatch(/n'a pas abouti/);
    expect(remoteStatusText({ status: "loading", options: [], more: false }, "hint", "vide")).toBe("Recherche…");
  });
});
