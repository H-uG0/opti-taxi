// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateToShow, dayHref, DayNav } from "./day-nav";
import { LeaveGuard } from "./leave-guard";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams("depot=d1&zoom=4h") }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/planning?date=2026-11-10&depot=d1&zoom=4h&trip=t1");
});

/** Lets the promise of requestLeave resolve. */
const settle = () => act(async () => {});

describe("dateToShow and dayHref", () => {
  it("takes only a complete date in range, other than the one shown", () => {
    expect(dateToShow("2026-11-12", "2026-11-10")).toBe("2026-11-12");
    expect(dateToShow("2026-11-10", "2026-11-10")).toBeNull();
    expect(dateToShow("0002-11-12", "2026-11-10")).toBeNull();
    expect(dateToShow("2026-02-30", "2026-11-10")).toBeNull();
    expect(dateToShow("", "2026-11-10")).toBeNull();
  });

  it("keeps the page's parameters and sets the date", () => {
    expect(dayHref("/courses", "2026-11-12", { statut: "annulee" })).toBe("/courses?statut=annulee&date=2026-11-12");
  });
});

describe("DayNav", () => {
  it("names the previous and next day with their date, and marks J+1", () => {
    render(<DayNav basePath="/planning" date="2026-11-11" tomorrow="2026-11-11" keepParams={["depot", "zoom"]} />);
    const previous = screen.getByRole("link", { name: "Jour précédent (10/11/2026)" });
    expect(previous.getAttribute("href")).toBe("/planning?depot=d1&zoom=4h&date=2026-11-10");
    expect(screen.getByRole("link", { name: "Jour suivant (12/11/2026)" })).toBeTruthy();
    expect(screen.getByText("J+1")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Demain" })).toBeNull();
  });

  it("never navigates while the date is typed: on Entrée (« Afficher ») or when the field is left", async () => {
    render(<DayNav basePath="/courses" date="2026-11-10" tomorrow="2026-11-11" params={{ statut: "annulee" }} fieldLabel="Date des courses" />);
    const field = screen.getByLabelText("Date des courses") as HTMLInputElement;
    // A day typed digit by digit goes through other valid dates: nothing happens on change.
    fireEvent.change(field, { target: { value: "2026-11-01" } });
    fireEvent.change(field, { target: { value: "2026-11-12" } });
    await settle();
    expect(router.push).not.toHaveBeenCalled();
    fireEvent.submit(field.form as HTMLFormElement);
    await settle();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/courses?statut=annulee&date=2026-11-12");
    // Leaving the field for « Afficher » does not ask twice for the same day.
    fireEvent.blur(field);
    await settle();
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("goes to the date typed when the field loses the focus", async () => {
    render(<DayNav basePath="/equipages" date="2026-11-10" tomorrow="2026-11-11" />);
    const field = screen.getByLabelText("Date") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "2026-11-14" } });
    fireEvent.blur(field);
    await settle();
    expect(router.push).toHaveBeenLastCalledWith("/equipages?date=2026-11-14");
  });

  it("goes to the previous and next day with « [ » and « ] », keeping the filters but not the trip", async () => {
    render(<DayNav basePath="/planning" date="2026-11-10" tomorrow="2026-11-11" keepParams={["depot", "zoom"]} shortcuts />);
    fireEvent.keyDown(document.body, { key: "[" });
    await settle();
    expect(router.push).toHaveBeenLastCalledWith("/planning?depot=d1&zoom=4h&date=2026-11-09");
    // AltGr on a French keyboard (Ctrl + Alt on Windows).
    fireEvent.keyDown(document.body, { key: "]", ctrlKey: true, altKey: true, modifierAltGraph: true });
    await settle();
    expect(router.push).toHaveBeenLastCalledWith("/planning?depot=d1&zoom=4h&date=2026-11-11");
    expect(screen.getByRole("link", { name: "Jour suivant (11/11/2026)" }).getAttribute("aria-keyshortcuts")).toBe("]");
  });

  it("leaves the keys alone without shortcuts, and while typing", async () => {
    const { unmount } = render(<DayNav basePath="/planning" date="2026-11-10" tomorrow="2026-11-11" />);
    fireEvent.keyDown(document.body, { key: "]" });
    await settle();
    expect(router.push).not.toHaveBeenCalled();
    unmount();
    render(<DayNav basePath="/planning" date="2026-11-10" tomorrow="2026-11-11" shortcuts fieldLabel="Date du planning" />);
    fireEvent.keyDown(screen.getByLabelText("Date du planning"), { key: "]" });
    await settle();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("asks before leaving unsaved changes, in the app's dialog, and stays on the date when told", async () => {
    render(
      <>
        <LeaveGuard message="La modification des équipages du 10/11/2026 n'est pas enregistrée : elle sera perdue si vous quittez la page." />
        <DayNav basePath="/equipages" date="2026-11-10" tomorrow="2026-11-11" />
      </>,
    );
    const field = screen.getByLabelText("Date") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "2026-11-14" } });
    fireEvent.submit(field.form as HTMLFormElement);
    const dialog = await screen.findByRole("alertdialog", { name: "Modifications non enregistrées" });
    expect(dialog.textContent).toContain("elle sera perdue");
    fireEvent.click(screen.getByRole("button", { name: "Rester sur la page" }));
    await settle();
    expect(router.push).not.toHaveBeenCalled();
    expect(field.value).toBe("2026-11-10");
    // Asked again, and agreed this time.
    fireEvent.change(field, { target: { value: "2026-11-14" } });
    fireEvent.submit(field.form as HTMLFormElement);
    fireEvent.click(await screen.findByRole("button", { name: "Quitter sans enregistrer" }));
    await settle();
    expect(router.push).toHaveBeenLastCalledWith("/equipages?date=2026-11-14");
  });
});
