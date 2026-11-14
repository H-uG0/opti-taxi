// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosedFacilitiesNote, type ClosedFacilityLine } from "./closed-facilities-note";

type Action = (state: unknown, formData: FormData) => Promise<{ ok: boolean; message: string }>;
const actions = vi.hoisted(() => ({
  cancelClosedFacilityTrips: vi.fn<Action>(async () => ({ ok: true, message: "2 courses annulées (établissement fermé)." })),
}));
vi.mock("@/app/(regulator)/courses/closed-facility-actions", () => actions);
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const radio: ClosedFacilityLine = {
  facilityId: "f1",
  name: "Radiothérapie",
  reason: "fermé les jours fériés",
  holiday: true,
  count: 2,
  tripIds: ["t1", "t2"],
};
const clinic: ClosedFacilityLine = {
  facilityId: "f3",
  name: "Clinique",
  reason: "fermé le 11/11/2026",
  holiday: false,
  count: 1,
  tripIds: ["t3"],
};

describe("ClosedFacilitiesNote (« Jour férié : N courses vers des établissements fermés »)", () => {
  it("cancels the trips of one facility only, posting the trips shown", async () => {
    render(<ClosedFacilitiesNote date="2026-11-11" title="Jour férié (Armistice 1918) : 3 courses" lines={[radio, clinic]} />);
    fireEvent.click(screen.getByRole("button", { name: "Annuler les 2 courses vers Radiothérapie" }));
    expect(screen.getByText(/^Annuler ces 2 courses vers Radiothérapie/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Oui, annuler les 2 courses" }));
    await waitFor(() => expect(actions.cancelClosedFacilityTrips).toHaveBeenCalledTimes(1));
    const sent = actions.cancelClosedFacilityTrips.mock.calls[0]![1];
    expect(sent.get("date")).toBe("2026-11-11");
    expect(sent.getAll("tripId")).toEqual(["t1", "t2"]);
    expect(await screen.findByText("2 courses annulées (établissement fermé).")).toBeTruthy();
  });

  it("cancels every trip shown at once", async () => {
    render(<ClosedFacilitiesNote date="2026-11-11" title="Jour férié" lines={[radio, clinic]} />);
    fireEvent.click(screen.getByRole("button", { name: "Annuler ces 3 courses" }));
    fireEvent.click(screen.getByRole("button", { name: "Oui, annuler les 3 courses" }));
    await waitFor(() => expect(actions.cancelClosedFacilityTrips).toHaveBeenCalledTimes(1));
    expect(actions.cancelClosedFacilityTrips.mock.calls[0]![1].getAll("tripId")).toEqual(["t1", "t2", "t3"]);
  });

  it("points to « Ouvert les jours fériés » only for a facility closed for the holiday, not for a dated closure", () => {
    const { unmount } = render(<ClosedFacilitiesNote date="2026-11-11" title="Fermeture" lines={[clinic]} />);
    expect(screen.queryByText(/Ouvert les jours fériés/)).toBeNull();
    // One facility: no button of its own, the global one is the same.
    expect(screen.queryByRole("button", { name: /vers Clinique/ })).toBeNull();
    unmount();
    render(<ClosedFacilitiesNote date="2026-11-11" title="Jour férié" lines={[radio]} />);
    expect(screen.getByText(/Ouvert les jours fériés/)).toBeTruthy();
  });
});
