// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegularPatientForm } from "./regular-patient-form";

vi.mock("server-only", () => ({}));
vi.mock("@/components/address/actions", () => ({ geocodeAddressAction: vi.fn() }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) };
});

afterEach(cleanup);

const FACILITIES = [
  { id: "dia", name: "Centre de dialyse de la Durance", city: "Manosque", type: "DIALYSIS" as const, typeLabel: "Centre de dialyse" },
  { id: "rad", name: "Institut de radiothérapie Méditerranée", city: "Marseille", type: "RADIOTHERAPY" as const, typeLabel: "Radiothérapie" },
  { id: "cli", name: "Clinique du Pays d'Aix", city: "Aix-en-Provence", type: "CLINIC" as const, typeLabel: "Clinique" },
];

function renderForm() {
  render(<RegularPatientForm action={vi.fn()} facilities={FACILITIES} todayIso="2026-11-14" geocoderEnabled={false} horizonEnd="2026-11-28" />);
}

const checkedDays = () =>
  [...document.querySelectorAll<HTMLInputElement>('input[name="weekdays"]')].filter((box) => box.checked).map((box) => box.value);

describe("RegularPatientForm (« Nouveau patient régulier »)", () => {
  it("proposes the rhythm of the facility chosen: dialysis Monday, Wednesday, Friday for 4 h; radiotherapy every weekday", () => {
    renderForm();
    const facility = screen.getByLabelText("Établissement");
    fireEvent.change(facility, { target: { value: "dia" } });
    expect(checkedDays()).toEqual(["1", "3", "5"]);
    expect((screen.getByLabelText("Durée de séance (min)") as HTMLInputElement).value).toBe("240");
    expect((screen.getByLabelText("Libellé (facultatif)") as HTMLInputElement).value).toBe("Dialyse");

    fireEvent.change(facility, { target: { value: "rad" } });
    expect(checkedDays()).toEqual(["1", "2", "3", "4", "5"]);
    expect((screen.getByLabelText("Durée de séance (min)") as HTMLInputElement).value).toBe("30");
  });

  it("keeps a rhythm typed by hand", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Durée de séance (min)"), { target: { value: "210" } });
    fireEvent.change(screen.getByLabelText("Établissement"), { target: { value: "dia" } });
    expect((screen.getByLabelText("Durée de séance (min)") as HTMLInputElement).value).toBe("210");
    expect(checkedDays()).toEqual(["1", "3", "5"]);
  });

  it("prescribes an ambulance for a lying patient, and ends the validity with a shortcut", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Mobilité"), { target: { value: "LYING" } });
    expect((screen.getByLabelText("Mode prescrit") as HTMLSelectElement).value).toBe("AMBULANCE");
    expect((screen.getByLabelText("Transport partagé autorisé") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "6 mois" }));
    expect((screen.getByLabelText("Fin de validité") as HTMLInputElement).value).toBe("2027-05-13");
    expect((screen.getByLabelText(/Prescription en série/) as HTMLInputElement).checked).toBe(true);
  });
});
