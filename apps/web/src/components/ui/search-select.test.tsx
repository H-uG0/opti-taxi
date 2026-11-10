// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterGroups, SearchSelect, type SearchSelectGroup, type SearchSelectOption } from "./search-select";

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
    fireEvent.click(screen.getByRole("button", { name: "Chauffeur de Taxi 1 : MARTIN Bob" }));
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
    const button = screen.getByRole("button", { name: "Chauffeur de Taxi 1 : BÉRARD Anaïs" });
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
