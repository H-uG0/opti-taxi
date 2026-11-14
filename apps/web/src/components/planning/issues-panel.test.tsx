// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tripView } from "@/test/planning-fixtures";
import { IssuesPanel, type LiveIssues } from "./issues-panel";

afterEach(cleanup);

const trips = {
  "trip-a": tripView({ id: "trip-a", patientName: "Jeanne Martin", appointmentMinute: 540 }),
  "trip-b": tripView({ id: "trip-b", patientName: "Paul Durand", direction: "RETURN", readyMinute: 690, appointmentMinute: null }),
};

function renderPanel(live: Partial<LiveIssues>) {
  const onSelectTrip = vi.fn();
  const onSelectVehicle = vi.fn();
  render(
    <IssuesPanel
      date="2026-11-16"
      unassigned={[]}
      violations={[]}
      violationsKnown
      staleTrips={[]}
      droppedLocks={[]}
      returnsToCheck={[]}
      vehicleIssues={[]}
      trips={trips}
      vehicleLabels={{ "taxi-1": "Taxi 1 (Marseille)", "vsl-2": "VSL 2 (Manosque)" }}
      planned
      selectedTripId={null}
      onSelectTrip={onSelectTrip}
      onSelectVehicle={onSelectVehicle}
      live={{
        nowMinute: 600,
        maxTotalWaitMin: 45,
        requests: [],
        requestActions: () => <button type="button">Pris en compte</button>,
        threatened: [],
        silent: [],
        overdue: [],
        longWaits: [],
        unseenRoadmaps: [],
        ...live,
      }}
    />,
  );
  return { onSelectTrip, onSelectVehicle };
}

const section = (title: RegExp) => screen.getByRole("heading", { name: title }).closest("section")!;

describe("IssuesPanel: « Suivi du jour »", () => {
  it("lists the threatened appointments, the silent routes, the stops without status and the long waits, counted in « À traiter »", () => {
    const { onSelectTrip, onSelectVehicle } = renderPanel({
      threatened: [{ tripId: "trip-a", vehicleId: "taxi-1", appointmentMinute: 540, projectedMinute: 552, lateMinutes: 12 }],
      silent: [{ vehicleId: "vsl-2", sinceMinute: 445, minutes: 155 }],
      overdue: [{ stopId: "s1", tripId: "trip-b", vehicleId: "taxi-1", kind: "PICKUP", minutes: 14, missing: false }],
      longWaits: [{ tripId: "trip-b", vehicleId: null, waitMinutes: 70, afterMinutes: 60, beforeMinutes: 10 }],
    });
    expect(screen.getByText("À traiter (4)")).toBeTruthy();
    expect(section(/RDV menacés \(1\)/).textContent).toContain("Arrivée vers 09:12, 12\u00a0min après le RDV");
    expect(section(/Tournées silencieuses \(1\)/).textContent).toContain("Aucun statut depuis 07:25 (2\u00a0h\u00a035)");
    expect(section(/Arrêts sans statut \(1\)/).textContent).toContain("Prise en charge attendue vers 09:46, sans statut depuis 14\u00a0min");
    expect(section(/Attentes de plus de 45/).textContent).toContain("Attente estimée 1\u00a0h\u00a010, dont 1\u00a0h\u00a000 après la séance");
    fireEvent.click(within(section(/RDV menacés/)).getByRole("button", { name: /Jeanne Martin/ }));
    expect(onSelectTrip).toHaveBeenCalledWith("trip-a");
    fireEvent.click(within(section(/Tournées silencieuses/)).getByRole("button", { name: /VSL 2/ }));
    expect(onSelectVehicle).toHaveBeenCalledWith("vsl-2");
  });

  it("lists the crews' requests with the regulator's answers, and the roadmaps whose change is not seen", () => {
    renderPanel({
      requests: [
        { id: "r1", kind: "READY_TIME", status: "PENDING", tripId: "trip-b", readyMinute: 680, previousReadyMinute: 690, cancellationReason: null, nextSessionDate: null, createdAt: "2026-11-16T09:05:00.000Z", createdBy: "Julien Marchetti" },
      ],
      unseenRoadmaps: [{ vehicleId: "taxi-1", text: "Modifiée à 10:42 (1\u00a0course retirée), pas encore vue" }],
    });
    const requests = section(/Demandes des équipages \(1\)/);
    expect(requests.textContent).toContain("Patient prêt à 11:20 (prévu 11:30)");
    expect(requests.textContent).toContain("Julien Marchetti, à 10:05");
    expect(within(requests).getByRole("button", { name: "Pris en compte" })).toBeTruthy();
    expect(section(/Changements pas encore vus \(1\)/).textContent).toContain("Modifiée à 10:42");
  });

  it("adds nothing without the follow-up", () => {
    renderPanel({});
    expect(screen.getByText("Toutes les courses sont affectées, sans violation.")).toBeTruthy();
  });
});
