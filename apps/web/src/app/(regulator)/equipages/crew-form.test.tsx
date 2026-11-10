// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrewForm, type CrewDepots, type CrewPersonOption, type CrewRow } from "./crew-form";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => search.params }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) =>
      React.createElement("a", { href, ...Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "replace" && key !== "scroll")) }, children),
  };
});
vi.mock("./actions", () => ({ saveDayCrews: vi.fn(async (state: unknown) => state) }));

afterEach(cleanup);
beforeEach(() => {
  search.params = new URLSearchParams();
  window.history.replaceState(null, "", "/equipages?date=2026-11-11");
});

function row(vehicleId: string, depotId: string, driverId: string | null, overrides: Partial<CrewRow> = {}): CrewRow {
  return {
    vehicleId,
    label: vehicleId,
    registration: "AA-000-AA",
    type: "TAXI",
    depotId,
    depotName: depotId === "gap" ? "Gap" : "Aix",
    driverId,
    crewMateId: null,
    origin: driverId ? "default" : "none",
    proposedSeats: [],
    fixed: null,
    savedVersion: null,
    shift: { start: 360, end: 1080 },
    issues: driverId ? [] : [{ level: "error", seat: "driver", message: "Aucun chauffeur disponible" }],
    blocked: driverId ? null : "Aucun chauffeur disponible",
    unavailable: false,
    flagged: false,
    ...overrides,
  };
}

function person(id: string, depotId: string): CrewPersonOption {
  return {
    id,
    name: id.toUpperCase(),
    active: true,
    depotId,
    absence: null,
    worksThatDay: true,
    canDrive: { TAXI: true, VSL: true, AMBULANCE: false },
    canCrew: false,
    qualifications: "Carte taxi",
  };
}

const ROWS = [row("Taxi 1", "aix", "ana"), row("Taxi 2", "gap", "bob"), row("Taxi 3", "gap", null)];
const PEOPLE = [person("ana", "aix"), person("bob", "gap"), person("cyd", "gap")];
const DEPOTS: CrewDepots = { names: { aix: "Aix", gap: "Gap" }, km: { aix: { gap: 150 }, gap: { aix: 150 } } };

const field = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`);

describe("CrewForm", () => {
  it("chooses a person from the grouped list and counts the change", () => {
    render(<CrewForm date="2026-11-11" rows={ROWS} people={PEOPLE} depots={DEPOTS} locked={null} hasSavedCrews={false} />);
    expect(screen.getByRole("button", { name: "Aucune modification" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chauffeur de Taxi 3 : — Aucun chauffeur —" }));
    const list = screen.getByRole("listbox");
    // The free person of the depot first; bob is on Taxi 2.
    expect(within(list).getByRole("group", { name: "Libres — dépôt Gap" }).textContent).toContain("CYD");
    expect(within(list).getByRole("group", { name: "Déjà sur un autre véhicule" }).textContent).toContain("sur Taxi 2");
    fireEvent.click(within(list).getByRole("option", { name: /CYD/ }));
    expect(field("driver:Taxi 3")?.value).toBe("cyd");
    expect(screen.getByRole("button", { name: "Enregistrer la modification" })).toBeTruthy();
    expect(screen.getByText("Modifié")).toBeTruthy();
    // The depot summary follows the form: Gap's seats are all filled, nobody is free there any more.
    expect(screen.getByRole("button", { name: /^Gap/ }).textContent).toContain("2/2 postes");
  });

  it("filters by depot from the address, keeping every row's fields in the form", () => {
    search.params = new URLSearchParams("date=2026-11-11&depot=gap");
    render(<CrewForm date="2026-11-11" rows={ROWS} people={PEOPLE} depots={DEPOTS} locked={null} hasSavedCrews={false} />);
    expect(screen.queryByRole("button", { name: /Chauffeur de Taxi 1/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Chauffeur de Taxi 2/ })).toBeTruthy();
    expect(field("driver:Taxi 1")?.value).toBe("ana");
    expect(screen.getByText(/2 véhicules affichés sur 3/)).toBeTruthy();
    // A tile shows one depot (or all again) without reloading the page.
    const replace = vi.spyOn(window.history, "replaceState");
    fireEvent.click(screen.getByRole("button", { name: /^Gap/ }));
    expect(replace).toHaveBeenLastCalledWith(null, "", "/equipages?date=2026-11-11");
  });

  it("shows only the rows to handle", () => {
    search.params = new URLSearchParams("etat=a-traiter");
    render(<CrewForm date="2026-11-11" rows={ROWS} people={PEOPLE} depots={DEPOTS} locked={null} hasSavedCrews={false} />);
    expect(screen.getAllByRole("button", { name: /^Chauffeur de/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Chauffeur de Taxi 3 : — Aucun chauffeur —",
    ]);
    expect(screen.getByLabelText("À traiter seulement (1)")).toBeTruthy();
  });

  it("asks before going back to the proposals for the whole day", () => {
    const fixed = [row("Taxi 1", "aix", "ana", { origin: "fixed", fixed: { version: "2026-11-10T08:00:00.000Z", by: "Marie" }, savedVersion: "2026-11-10T08:00:00.000Z" })];
    render(<CrewForm date="2026-11-11" rows={fixed} people={PEOPLE} depots={DEPOTS} locked={null} hasSavedCrews />);
    expect(screen.queryByRole("button", { name: "Revenir aux propositions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revenir aux propositions (tout le jour)" }));
    const confirm = screen.getByRole("group", { name: "Confirmer le retour aux propositions" });
    expect(confirm.textContent).toContain("L'équipage fixé (par Marie) sera oublié.");
    const submit = within(confirm).getByRole("button", { name: "Oui, revenir aux propositions" });
    expect(submit.getAttribute("type")).toBe("submit");
    expect(submit.getAttribute("value")).toBe("reset");
    fireEvent.click(within(confirm).getByRole("button", { name: "Garder les équipages" }));
    expect(screen.queryByRole("group", { name: "Confirmer le retour aux propositions" })).toBeNull();
    // The focus goes back to the button that asked.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revenir aux propositions (tout le jour)" }));
  });

  it("starts afresh on another date: the seats of the day before are neither shown nor counted as changes", () => {
    const { rerender } = render(<CrewForm date="2026-11-11" rows={ROWS} people={PEOPLE} depots={DEPOTS} locked={null} hasSavedCrews={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Chauffeur de Taxi 3 : — Aucun chauffeur —" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /CYD/ }));
    expect(screen.getByRole("button", { name: "Enregistrer la modification" })).toBeTruthy();
    // « Jour suivant »: the same page with the next day's rows (bob absent, Taxi 3 out of service).
    const next = [row("Taxi 1", "aix", "ana"), row("Taxi 2", "gap", null), row("Taxi 3", "gap", null, { unavailable: true, issues: [], blocked: null })];
    rerender(<CrewForm date="2026-11-12" rows={next} people={PEOPLE} depots={DEPOTS} locked={null} hasSavedCrews={false} />);
    expect(screen.getByRole("button", { name: "Aucune modification" })).toBeTruthy();
    expect(screen.queryByText("Modifié")).toBeNull();
    expect(screen.getByRole("button", { name: "Chauffeur de Taxi 2 : — Aucun chauffeur —" })).toBeTruthy();
    expect(field("driver:Taxi 2")?.value).toBe("");
  });

  it("asks before leaving the date with unsaved changes, in the app's dialog", async () => {
    render(<CrewForm date="2026-11-11" rows={ROWS} people={PEOPLE} depots={DEPOTS} locked={null} hasSavedCrews={false} />);
    const link = document.body.appendChild(document.createElement("a"));
    link.href = "/equipages?date=2026-11-12";
    link.textContent = "Jour suivant";
    // Nothing to lose yet: no question.
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Chauffeur de Taxi 3 : — Aucun chauffeur —" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /CYD/ }));
    // Another date: asked in the app's dialog (never the browser's), the link does not navigate meanwhile.
    expect(fireEvent.click(link)).toBe(false);
    const dialog = await screen.findByRole("alertdialog", { name: "Modifications non enregistrées" });
    expect(dialog.textContent).toContain("La modification des équipages du 11/11/2026 n'est pas enregistrée");
    // « Rester sur la page »: nothing lost, the focus back where it was.
    fireEvent.click(within(dialog).getByRole("button", { name: "Rester sur la page" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Enregistrer la modification" })).toBeTruthy();
    // The same date (a filter, an anchor): no question.
    link.href = "/equipages?date=2026-11-11&depot=gap";
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    link.remove();
  });
});
