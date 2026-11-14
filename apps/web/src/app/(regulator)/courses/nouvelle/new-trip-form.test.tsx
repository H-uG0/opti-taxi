// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewTripForm, type PatientOption } from "./new-trip-form";

vi.mock("server-only", () => ({}));
vi.mock("@/components/address/actions", () => ({ geocodeAddressAction: vi.fn() }));
vi.mock("../actions", () => ({ createTrip: vi.fn(async (state: unknown) => state) }));
vi.mock("./actions", () => ({ searchTripPatients: vi.fn(), loadPatientForTrip: vi.fn() }));
import { loadPatientForTrip, searchTripPatients } from "./actions";
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) };
});

afterEach(cleanup);

const FACILITIES = [
  { id: "f1", label: "Centre de dialyse de la Durance — Manosque (Centre de dialyse)" },
  { id: "f2", label: "Clinique du Pays d'Aix — Aix-en-Provence (Clinique)" },
];

const PATIENT: PatientOption = {
  id: "p1",
  label: "RUIZ Marie-Thérèse — Forcalquier",
  mobilityLabel: "Assis",
  usualFacilityId: "f1",
  usualSessionMinutes: 240,
  prescriptions: [
    { id: "pre1", mode: "TAP", sharing: "OUTBOUND", validFrom: "2026-07-23", validTo: "2027-03-14", label: "Assis (taxi ou VSL) · partage aller" },
  ],
};

function renderForm(patient: PatientOption | null = PATIENT, date = "2026-11-16") {
  render(<NewTripForm initialPatient={patient} facilities={FACILITIES} initialDate={date} today="2026-11-14" geocoder={false} />);
}

describe("NewTripForm (« Nouvelle course »)", () => {
  it("opens on the patient of the record, their usual facility proposed", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /Patient : RUIZ Marie-Thérèse/ })).toBeTruthy();
    expect((document.querySelector('input[name="patientId"]') as HTMLInputElement).value).toBe("p1");
    const facility = screen.getByLabelText("Établissement de soins") as HTMLSelectElement;
    expect(facility.value).toBe("f1");
    expect(screen.getByText("Établissement habituel du patient.")).toBeTruthy();
  });

  it("suggests the end of session of « Aller et retour » from the usual session, until typed by hand", () => {
    renderForm();
    fireEvent.click(screen.getByLabelText("Aller et retour"));
    fireEvent.change(screen.getByLabelText("Heure du rendez-vous"), { target: { value: "07:30" } });
    const back = screen.getByLabelText("Fin de séance (retour)") as HTMLInputElement;
    expect(back.value).toBe("11:30");
    fireEvent.change(back, { target: { value: "12:00" } });
    fireEvent.change(screen.getByLabelText("Heure du rendez-vous"), { target: { value: "08:00" } });
    expect(back.value).toBe("12:00");
    expect(screen.getByRole("button", { name: "Créer l'aller et le retour" })).toBeTruthy();
    // The prescription allows sharing on the outbound leg only.
    expect(screen.getByText(/possible sur l'aller seulement/)).toBeTruthy();
  });

  it("proposes the next patient's usual facility in place of the one proposed for the previous one, not over a choice", async () => {
    vi.mocked(searchTripPatients).mockResolvedValue({ status: "ok", more: false, options: [{ value: "p2", label: "MARTIN Paul", hint: "Aix" }] });
    vi.mocked(loadPatientForTrip).mockResolvedValue({ ...PATIENT, id: "p2", label: "MARTIN Paul — Aix", usualFacilityId: "f2" });
    renderForm();
    const facility = screen.getByLabelText("Établissement de soins") as HTMLSelectElement;
    expect(facility.value).toBe("f1");
    const choose = async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Patient/ }));
      fireEvent.change(screen.getByPlaceholderText("Nom, ville ou téléphone…"), { target: { value: "martin" } });
      fireEvent.click(await screen.findByRole("option", { name: /MARTIN Paul/ }));
      await waitFor(() => expect(screen.getByRole("button", { name: /Patient\u00a0: MARTIN Paul/ })).toBeTruthy());
    };
    await choose();
    expect(vi.mocked(loadPatientForTrip)).toHaveBeenCalledWith("p2");
    expect(facility.value).toBe("f2");
    expect((document.querySelector('input[name="patientId"]') as HTMLInputElement).value).toBe("p2");

    // A facility chosen by hand stays.
    fireEvent.change(facility, { target: { value: "f1" } });
    vi.mocked(loadPatientForTrip).mockResolvedValue({ ...PATIENT, id: "p3", label: "MARTIN Paul — Aix", usualFacilityId: "f2" });
    await choose();
    expect(facility.value).toBe("f1");
  });

  it("offers « Nouvelle prescription », back to this trip with what was chosen (never the notes), when none covers the date", () => {
    renderForm(PATIENT, "2027-04-01");
    fireEvent.change(screen.getByLabelText("Heure du rendez-vous"), { target: { value: "08:15" } });
    const link = screen.getByRole("link", { name: "Nouvelle prescription" });
    // Opened from Courses (no record): back there afterwards.
    expect(link.getAttribute("href")).toBe("/patients/p1/prescriptions/nouvelle?course=2027-04-01&sens=OUTBOUND&heure=08%3A15&etab=f1&retour=courses");
  });

  it("comes back from « Nouvelle prescription » with the choices carried, « Annuler » to the record it was opened from", () => {
    render(
      <NewTripForm
        initialPatient={PATIENT}
        facilities={FACILITIES}
        initialDate="2026-11-16"
        today="2026-11-14"
        geocoder={false}
        draft={{ direction: "BOTH", time: "08:15", returnTime: "12:40", facilityId: "f2" }}
        fromRecord
        cancelHref="/patients/p1"
      />,
    );
    expect((screen.getByLabelText("Établissement de soins") as HTMLSelectElement).value).toBe("f2");
    expect((document.querySelector('input[name="time"]') as HTMLInputElement).value).toBe("08:15");
    expect((document.querySelector('input[name="returnTime"]') as HTMLInputElement).value).toBe("12:40");
    expect((document.querySelector('input[name="direction"][value="BOTH"]') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("link", { name: "Annuler" }).getAttribute("href")).toBe("/patients/p1");
  });

  it("ships no patient list: the choice is searched", () => {
    renderForm(null);
    expect(screen.getByRole("button", { name: /Patient : Choisissez un patient/ })).toBeTruthy();
    expect(document.querySelectorAll("option").length).toBe(FACILITIES.length + 1 + 1);
  });
});
