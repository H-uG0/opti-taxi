// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrip } from "./actions";
import { TripRow, type TripRowData } from "./trip-row";

vi.mock("./actions", () => ({
  cancelTrip: vi.fn(async (state: unknown) => state),
  restoreTrip: vi.fn(async (state: unknown) => state),
  rescheduleTrip: vi.fn(),
  recordSharingDecision: vi.fn(),
  setTripToll: vi.fn(),
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) };
});

afterEach(() => {
  cleanup();
  vi.mocked(cancelTrip).mockClear();
});

const TRIP: TripRowData = {
  id: "t1",
  direction: "OUTBOUND",
  status: "PLANNED",
  statusTraces: [],
  statusTraceShort: null,
  payer: "CPAM",
  patientName: "Patient Un",
  patientPhone: null,
  keyMinute: 540,
  facilityName: "Centre",
  pickupAddress: "1 rue A",
  dropoffAddress: "2 rue B",
  allowedVehicleTypes: ["TAXI", "VSL"],
  prescriptionLabel: "Assis",
  origin: null,
  vehicleLabel: "Taxi 1",
  vehicleType: "TAXI",
  lockedVehicleLabel: null,
  plannedPickupMinute: null,
  plannedDropoffMinute: null,
  shared: false,
  coPassengers: [],
  directKm: null,
  detourKm: null,
  estimatedRevenue: null,
  sharingAllowed: true,
  sharingStatus: "NOT_PROPOSED",
  sharingProposedAt: null,
  sharingAnswer: null,
  sharingAnswerShort: null,
  sharingNote: null,
  notes: null,
  outboundNoShow: false,
  outboundNoShowTrace: null,
  cancellation: null,
  cancellationReason: null,
  lateCancellation: false,
  cancellationTrace: null,
  pairedReturn: null,
  conflicts: [],
};

function openCancelForm() {
  render(
    <table>
      <tbody>
        <TripRow trip={TRIP} />
      </tbody>
    </table>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Détails de la course de Patient Un" }));
  const note = screen.getByLabelText(/^Précision/);
  return { note, form: note.closest("form") as HTMLFormElement };
}

describe("Annuler la course (one trip)", () => {
  it("asks before cancelling when Entrée submits the form from « Précision »", async () => {
    const { note, form } = openCancelForm();
    fireEvent.change(screen.getByLabelText("Motif de l'annulation"), { target: { value: "PATIENT" } });
    fireEvent.change(note, { target: { value: "prévenu par sa fille" } });
    // Entrée in the only text field: the browser submits the form without a submit button (implicit submission).
    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: "Oui, annuler la course" })).toBeTruthy();
    expect(cancelTrip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Oui, annuler la course" }));
    await waitFor(() => expect(cancelTrip).toHaveBeenCalledTimes(1));
  });

  it("asks nothing while the reason is missing, or the note with « Autre motif »", () => {
    const { note, form } = openCancelForm();
    fireEvent.submit(form);
    expect(screen.queryByRole("button", { name: "Oui, annuler la course" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Motif de l'annulation"), { target: { value: "OTHER" } });
    expect((note as HTMLInputElement).required).toBe(true);
    fireEvent.submit(form);
    expect(screen.queryByRole("button", { name: "Oui, annuler la course" })).toBeNull();
    expect(cancelTrip).not.toHaveBeenCalled();
  });
});
