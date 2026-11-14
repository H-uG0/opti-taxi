// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { upcomingDays, type UpcomingTripInput } from "../_lib/upcoming";
import { UpcomingTrips } from "./upcoming-trips";

type Action = (state: unknown, formData: FormData) => Promise<{ ok: boolean; message: string }>;
const actions = vi.hoisted(() => ({
  cancelTrips: vi.fn<Action>(async () => ({ ok: true, message: "2 courses annulées (demande du patient)." })),
  restoreTrip: vi.fn<Action>(async () => ({ ok: true, message: "Course rétablie." })),
}));
vi.mock("../../courses/actions", () => actions);
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function trip(id: string, overrides: Partial<UpcomingTripInput> = {}): UpcomingTripInput {
  return {
    id,
    serviceDate: fromIsoDate("2026-11-16"),
    direction: "OUTBOUND",
    status: "PLANNED",
    appointmentMinute: 780,
    readyMinute: null,
    plannedPickupMinute: null,
    routeId: null,
    oneOffAddress: false,
    notes: null,
    shared: false,
    sharingStatus: "NOT_PROPOSED",
    cancellationReason: null,
    cancellationOrigin: null,
    cancellationNote: null,
    lateCancellation: false,
    facility: { name: "Centre de dialyse" },
    ...overrides,
  };
}

const days = () =>
  upcomingDays(
    [
      trip("a1", { routeId: "r1" }),
      trip("r1", { direction: "RETURN", appointmentMinute: null, readyMinute: 1020 }),
      trip("a2", { serviceDate: fromIsoDate("2026-11-18"), status: "CANCELLED", cancellationReason: "PATIENT" }),
    ],
    [],
    "p1",
    "2026-11-14",
  );

describe("UpcomingTrips (« Prochaines courses » of the record)", () => {
  it("cancels a whole day with one reason, after the question", async () => {
    render(<UpcomingTrips days={days()} />);
    fireEvent.click(screen.getByRole("button", { name: "Annuler ce jour (aller et retour)" }));
    fireEvent.change(screen.getByLabelText("Motif de l'annulation"), { target: { value: "PATIENT" } });
    fireEvent.click(screen.getByRole("button", { name: "Annuler les 2 courses" }));
    // The text matcher compares with collapsed spaces: the narrow no-break space before « ? » is one of them.
    expect(screen.getByText("Annuler l'aller et le retour du 16/11/2026 ? 1 course sera retirée de sa tournée.")).toBeTruthy();
    expect(actions.cancelTrips).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Oui, annuler les 2 courses" }));
    await waitFor(() => expect(actions.cancelTrips).toHaveBeenCalledTimes(1));
    const sent = actions.cancelTrips.mock.calls[0]![1];
    expect(sent.getAll("tripId")).toEqual(["a1", "r1"]);
    expect(sent.get("reason")).toBe("PATIENT");
    expect(await screen.findByText("2 courses annulées (demande du patient).")).toBeTruthy();
  });

  it("restores a cancelled trip and keeps the answer on screen", async () => {
    render(<UpcomingTrips days={days()} />);
    fireEvent.click(screen.getByRole("button", { name: "Rétablir la course du 18/11/2026 (aller)" }));
    await waitFor(() => expect(actions.restoreTrip).toHaveBeenCalledTimes(1));
    expect(actions.restoreTrip.mock.calls[0]![1].get("tripId")).toBe("a2");
    expect(await screen.findByText("Course rétablie.")).toBeTruthy();
  });

  it("offers to change or cancel an open trip, never a trip started or closed", () => {
    render(<UpcomingTrips days={days()} />);
    expect(screen.getByRole("link", { name: "Modifier la course du 16/11/2026 (aller)" }).getAttribute("href")).toBe(
      "/courses/a1/modifier?retour=patient",
    );
    expect(screen.queryByRole("button", { name: "Annuler la course du 18/11/2026 (aller)" })).toBeNull();
  });
});
