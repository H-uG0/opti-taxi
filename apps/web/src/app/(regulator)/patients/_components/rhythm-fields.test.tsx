// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DaySchedulesFields, SessionDatesField } from "./rhythm-fields";

afterEach(cleanup);

function Dates() {
  const [value, setValue] = useState("");
  return <SessionDatesField value={value} onChange={setValue} todayIso="2026-11-16" />;
}

describe("SessionDatesField (« Ajouter une série »)", () => {
  it("says why a series cannot be built instead of adding nothing silently", () => {
    render(<Dates />);
    fireEvent.change(screen.getByLabelText("Tous les (jours)"), { target: { value: "trois" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter ces dates" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/attendent un nombre entier/);
    expect(screen.getByLabelText("Tous les (jours)").getAttribute("aria-describedby")).toBe(alert.id);
    // Corrected: the message goes, the dates are added.
    fireEvent.change(screen.getByLabelText("Tous les (jours)"), { target: { value: "21" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Nombre de séances"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter ces dates" }));
    expect((screen.getByLabelText(/Dates des séances/) as HTMLTextAreaElement).value).toBe("16/11/2026\n07/12/2026");
  });
});

describe("DaySchedulesFields (« Horaire différent selon le jour »)", () => {
  it("gives the common length as the form says it, under visible column headings", () => {
    render(<DaySchedulesFields weekdays={[1, 5]} dayTimes={{}} daySessions={{}} errors={{}} commonTime="07:30" commonSession="240" />);
    expect(document.body.textContent).toContain("l'heure et la durée communes (07:30, 4\u00a0h\u00a000).");
    expect(screen.getByText("Heure du RDV")).toBeTruthy();
    expect(screen.getByText("Durée de séance (min)")).toBeTruthy();
  });
});
