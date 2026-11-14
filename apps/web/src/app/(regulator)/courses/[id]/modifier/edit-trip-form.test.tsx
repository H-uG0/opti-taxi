// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditTripForm, type EditTripInitial } from "./edit-trip-form";

vi.mock("server-only", () => ({}));
vi.mock("@/components/address/actions", () => ({ geocodeAddressAction: vi.fn() }));
vi.mock("../../actions", () => ({ updateTrip: vi.fn(async (_id: string, state: unknown) => state) }));

afterEach(cleanup);

const INITIAL: EditTripInitial = {
  serviceDate: "2026-11-16",
  time: "07:30",
  facilityId: "f1",
  homeMode: "home",
  homeAddress: "",
  homeLat: "",
  homeLng: "",
  careAddress: "",
  careLat: "",
  careLng: "",
  notes: "Salle 3",
};

function renderForm(overrides: Partial<Parameters<typeof EditTripForm>[0]> = {}) {
  render(
    <EditTripForm
      tripId="t1"
      direction="OUTBOUND"
      payer="CPAM"
      homeAddress="36 rue des Lilas, 04300 Forcalquier"
      facilities={[{ id: "f1", label: "Centre de dialyse de la Durance" }]}
      initial={INITIAL}
      today="2026-11-14"
      geocoder={false}
      cancelHref="/courses?date=2026-11-16"
      recurrenceLabel="Dialyse"
      {...overrides}
    />,
  );
}

describe("EditTripForm (« Modifier la course »)", () => {
  it("asks for an address for this trip only when « Autre adresse » is chosen", () => {
    renderForm();
    expect(screen.getByLabelText(/Domicile.*36 rue des Lilas/)).toBeTruthy();
    expect(screen.queryByLabelText("Adresse de prise en charge")).toBeNull();
    fireEvent.click(screen.getByLabelText("Autre adresse pour cette course"));
    expect(screen.getByLabelText("Adresse de prise en charge")).toBeTruthy();
    expect(screen.getByText(/le domicile de la fiche ne change pas/)).toBeTruthy();
    expect((screen.getByLabelText(/Notes pour le chauffeur/) as HTMLTextAreaElement).value).toBe("Salle 3");
    expect(screen.getByText(/ne vaut que pour cette séance/)).toBeTruthy();
  });

  it("lets a private trip go to a free address, a return trip drop the patient elsewhere", () => {
    renderForm({ payer: "PRIVATE", direction: "RETURN", recurrenceLabel: null, initial: { ...INITIAL, facilityId: "", careAddress: "Gare, 13001 Marseille" } });
    expect((screen.getByLabelText("Adresse de prise en charge") as HTMLInputElement).value).toBe("Gare, 13001 Marseille");
    expect(screen.getByText("Où déposer le patient")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enregistrer la course" })).toBeTruthy();
  });
});
