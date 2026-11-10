// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TripRowData } from "./trip-row";
import { bulkConfirmText, TripTable, untickedReturns } from "./trip-table";

vi.mock("./actions", () => ({
  cancelTrips: vi.fn(async (state: unknown) => state),
  cancelTrip: vi.fn(),
  restoreTrip: vi.fn(),
  rescheduleTrip: vi.fn(),
  recordSharingDecision: vi.fn(),
  setTripToll: vi.fn(),
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) };
});

afterEach(cleanup);

function trip(id: string, overrides: Partial<TripRowData> = {}): TripRowData {
  return {
    id,
    direction: "OUTBOUND",
    status: "PLANNED",
    statusTraces: [],
    statusTraceShort: null,
    payer: "CPAM",
    patientName: `Patient ${id}`,
    patientPhone: null,
    keyMinute: 540,
    facilityName: "Centre",
    pickupAddress: "1 rue A",
    dropoffAddress: "2 rue B",
    allowedVehicleTypes: ["TAXI", "VSL"],
    prescriptionLabel: "Assis",
    origin: null,
    vehicleLabel: null,
    vehicleType: null,
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
    ...overrides,
  };
}

const back = (id: string, inRoute = false) => ({ id, keyMinute: 690, inRoute, shared: false });

// a1 and a2: outbound trips with their returns r1 (shown) and r2 (filtered out of the list); a1 in a route.
const ROWS = [
  trip("a1", { vehicleLabel: "Taxi 1", vehicleType: "TAXI", pairedReturn: back("r1", true) }),
  trip("a2", { pairedReturn: back("r2") }),
  trip("r1", { direction: "RETURN", keyMinute: 690, vehicleLabel: "Taxi 1", vehicleType: "TAXI" }),
];

const box = (id: string) => screen.getByRole("checkbox", { name: new RegExp(`Patient ${id}`) });
const submitted = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[name="tripId"]')).map((i) => i.value);

describe("Annuler la sélection", () => {
  it("lists the returns of the ticked outbound trips not ticked themselves", () => {
    expect(untickedReturns(["a1", "a2"], ROWS).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(untickedReturns(["a1", "r1"], ROWS)).toEqual([]);
  });

  it("takes the returns along for the reasons that cancel the return of one trip, and asks in the future tense", () => {
    render(<TripTable rows={ROWS} caption="Courses" />);
    fireEvent.click(box("a1"));
    fireEvent.click(box("a2"));
    const bar = screen.getByRole("form", { name: "Annuler les courses sélectionnées" });
    const returns = within(bar).getByRole("checkbox", { name: "Annuler aussi les 2 retours de ces patients (non cochés)" });
    // No reason yet: the returns stay.
    expect((returns as HTMLInputElement).checked).toBe(false);
    expect(submitted()).toEqual(["a1", "a2"]);
    fireEvent.change(within(bar).getByLabelText("Motif de l'annulation"), { target: { value: "HOSPITALIZATION" } });
    expect((returns as HTMLInputElement).checked).toBe(true);
    expect(submitted()).toEqual(["a1", "a2", "r1", "r2"]);

    fireEvent.click(within(bar).getByRole("button", { name: "Annuler les 4 courses" }));
    const confirm = within(bar).getByRole("group", { name: "Confirmer l'annulation" });
    expect(confirm.textContent).toContain("Annuler 4 courses pour le motif «\u202fHospitalisation\u202f»\u202f? 2 seront retirées de leur tournée.");
    expect(confirm.textContent).toContain("sera tracée course par course");

    expect(within(confirm).getByRole("button", { name: "Oui, annuler les 4 courses" }).getAttribute("type")).toBe("submit");
    // « Garder les courses »: the focus goes back to the button that asked.
    fireEvent.click(within(confirm).getByRole("button", { name: "Garder les courses" }));
    expect(document.activeElement).toBe(within(bar).getByRole("button", { name: "Annuler les 4 courses" }));

    // Unticked by hand: said in the question.
    fireEvent.click(returns);
    fireEvent.click(within(bar).getByRole("button", { name: "Annuler les 2 courses" }));
    expect(within(bar).getByRole("group", { name: "Confirmer l'annulation" }).textContent).toContain("2 retours de ces patients restent prévus.");
  });

  it("goes to the bar with Entrée on a ticked box", () => {
    render(<TripTable rows={ROWS} caption="Courses" />);
    fireEvent.click(box("a2"));
    fireEvent.keyDown(box("a2"), { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByLabelText("Motif de l'annulation"));
    expect(box("a1").getAttribute("aria-describedby")).toBeTruthy();
  });

  it("words the question for one trip", () => {
    expect(bulkConfirmText({ count: 1, reason: "PATIENT", inRoutes: 1, shared: true, returnsLeft: 1 })).toBe(
      "Annuler 1 course pour le motif «\u202fDemande du patient\u202f»\u202f? Une sera retirée de sa tournée. Les co-passagers restés seuls ne seront plus en transport partagé. Le retour de ce patient reste prévu. Chaque course gardera son motif et l'annulation sera tracée course par course.",
    );
  });
});
