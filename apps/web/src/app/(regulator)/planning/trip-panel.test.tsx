// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planningFixture } from "@/test/planning-fixtures";
import type { TripView } from "@/lib/planning/types";
import { PlanningActivityProvider } from "./planning-activity";
import { TripPanel } from "./trip-panel";

// The server actions are not loaded: only what the panel sends them is checked.
const actions = vi.hoisted(() => ({
  lockTrip: vi.fn(async () => ({ ok: true, message: "Course figée." })),
  unlockTrip: vi.fn(async () => ({ ok: true, message: "Course défigée." })),
  moveTrip: vi.fn(async () => ({ ok: true, message: "Course déplacée." })),
  proposeExceptionalAmbulance: vi.fn(async () => ({ ok: true, message: "Course confiée à l'ambulance." })),
}));
vi.mock("./actions", () => actions);

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function renderPanel(trip: TripView, props: { replanBlocked?: string | null; lockBlocked?: string | null } = {}) {
  const { trips, vehicles } = planningFixture();
  const onClose = vi.fn();
  const onSelectTrip = vi.fn();
  render(
    <PlanningActivityProvider timeLimitSec={10}>
      <TripPanel
        trip={trip}
        trips={trips}
        vehicles={vehicles}
        violations={[]}
        date="2026-11-10"
        replanBlocked={props.replanBlocked ?? null}
        lockBlocked={props.lockBlocked ?? null}
        onSelectTrip={onSelectTrip}
        onClose={onClose}
      />
    </PlanningActivityProvider>,
  );
  return { onClose, onSelectTrip };
}

const moveSelect = () => screen.getByLabelText("Déplacer vers…") as HTMLSelectElement;
const optionLabels = () => Array.from(moveSelect().options).map((o) => o.textContent);

describe("TripPanel (panneau course)", () => {
  it("offers only the available vehicles of an allowed type, other than the trip's own", () => {
    renderPanel(planningFixture().trips["trip-a"]!);
    expect(optionLabels()).toEqual(["Déplacer vers…", "VSL 1 (Marseille) — libre"]);
  });

  it("offers nothing to an ambulance trip without another ambulance, and says so", () => {
    renderPanel({ ...planningFixture().trips["trip-a"]!, allowedVehicleTypes: ["AMBULANCE"], vehicleId: "amb-1" });
    expect(optionLabels()).toEqual(["Aucun véhicule compatible disponible"]);
    expect(moveSelect().disabled).toBe(true);
  });

  it("moves the trip to the chosen vehicle, the button enabled only once a vehicle is chosen", async () => {
    renderPanel(planningFixture().trips["trip-a"]!);
    const move = screen.getByRole("button", { name: "Déplacer" }) as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    fireEvent.change(moveSelect(), { target: { value: "vsl-1" } });
    expect(move.disabled).toBe(false);
    fireEvent.click(move);
    await waitFor(() => expect(actions.moveTrip).toHaveBeenCalledWith("trip-a", "vsl-1"));
  });

  it("freezes the trip on its vehicle, or unfreezes it, and blocks both on a past date", async () => {
    renderPanel(planningFixture().trips["trip-a"]!);
    fireEvent.click(screen.getByRole("button", { name: /Figer/ }));
    await waitFor(() => expect(actions.lockTrip).toHaveBeenCalledWith("trip-a", "taxi-1"));
    cleanup();

    renderPanel({ ...planningFixture().trips["trip-a"]!, lockedVehicleId: "taxi-1" });
    expect(screen.getByText(/figée sur Taxi 1 \(Marseille\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Défiger/ }));
    await waitFor(() => expect(actions.unlockTrip).toHaveBeenCalledWith("trip-a"));
    cleanup();

    renderPanel(planningFixture().trips["trip-a"]!, { lockBlocked: "Date passée : rien ne peut plus changer." });
    expect((screen.getByRole("button", { name: /Figer/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says why a cancelled trip cannot move, and names the shared trip, which can be opened", () => {
    const { onSelectTrip } = renderPanel(planningFixture().trips["trip-a"]!);
    fireEvent.click(screen.getByRole("button", { name: "Gérard Blanc" }));
    expect(onSelectTrip).toHaveBeenCalledWith("trip-b");
    cleanup();

    renderPanel({ ...planningFixture().trips["trip-a"]!, status: "CANCELLED" });
    expect(screen.getByText("Course annulée.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Déplacer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers an exceptional ambulance for a seated trip the optimizer left unassigned only, and sends the one chosen", async () => {
    const unassigned = { ...planningFixture().trips["trip-a"]!, vehicleId: null, coPassengerTripIds: [], shared: false, leftByOptimizer: true };
    renderPanel(unassigned);
    const select = screen.getByLabelText("Ambulance proposée") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Choisir une ambulance", "Ambulance 1 (Marseille) — libre"]);
    const propose = screen.getByRole("button", { name: "Proposer" }) as HTMLButtonElement;
    expect(propose.disabled).toBe(true);
    fireEvent.change(select, { target: { value: "amb-1" } });
    fireEvent.click(propose);
    await waitFor(() => expect(actions.proposeExceptionalAmbulance).toHaveBeenCalledWith("trip-a", "amb-1"));
    cleanup();

    // Served, prescribed in ambulance or private: no offer.
    renderPanel(planningFixture().trips["trip-a"]!);
    expect(screen.queryByText("Recours exceptionnel à une ambulance")).toBeNull();
    cleanup();
    renderPanel({ ...unassigned, allowedVehicleTypes: ["AMBULANCE"] });
    expect(screen.queryByText("Recours exceptionnel à une ambulance")).toBeNull();
    cleanup();
    renderPanel({ ...unassigned, payer: "PRIVATE", allowedVehicleTypes: ["TAXI"] });
    expect(screen.queryByText("Recours exceptionnel à une ambulance")).toBeNull();
    cleanup();

    // Not yet optimized, or added since the last computation: no taxi or VSL was tried, optimize first.
    renderPanel({ ...unassigned, leftByOptimizer: false });
    expect(screen.queryByLabelText("Ambulance proposée")).toBeNull();
    expect(screen.getByText(/^Optimisez d'abord la journée/)).toBeTruthy();
  });

  it("warns that « Défiger » ends the exceptional measure", () => {
    renderPanel({ ...planningFixture().trips["trip-a"]!, vehicleId: "amb-1", lockedVehicleId: "amb-1", exceptionalAmbulance: true });
    expect(screen.getByText("« Défiger » retire le recours exceptionnel à l'ambulance.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Défiger/ }).getAttribute("title")).toMatch(/^Retire le recours exceptionnel/);
  });

  it("shows a trip carried by an ambulance as an exceptional measure, at the VSL tariff", () => {
    renderPanel({ ...planningFixture().trips["trip-a"]!, vehicleId: "amb-1", lockedVehicleId: "amb-1", exceptionalAmbulance: true });
    expect(screen.getByText("Recours exceptionnel")).toBeTruthy();
    expect(screen.getByText("Ambulance pour un transport assis : tarif VSL.")).toBeTruthy();
  });

  it("gives what is needed to call the patient or brief the crew, and the links to the record and to Courses", () => {
    renderPanel({
      ...planningFixture().trips["trip-a"]!,
      mobility: "WHEELCHAIR",
      accessNotes: "3e étage sans ascenseur, digicode 4512",
      notes: "Prévoir la rampe",
      facilityPhone: "04 91 22 33 44",
    });
    const call = screen.getByRole("link", { name: "Appeler Monique Aubert : 04 91 00 00 01" });
    expect(call.getAttribute("href")).toBe("tel:0491000001");
    expect(screen.getByRole("link", { name: /^Appeler Centre de dialyse des Oliviers/ }).getAttribute("href")).toBe("tel:0491223344");
    expect(screen.getByText("Fauteuil roulant")).toBeTruthy();
    expect(screen.getByText("3e étage sans ascenseur, digicode 4512")).toBeTruthy();
    expect(screen.getByText("Prévoir la rampe")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Fiche patient" }).getAttribute("href")).toBe("/patients/patient-a");
    // By the patient's id: the name never goes into a URL.
    const courses = "/courses?date=2026-11-10&sens=OUTBOUND&patient=patient-a";
    expect(screen.getByRole("link", { name: "Voir dans Courses" }).getAttribute("href")).toBe(courses);
    // « Accord du patient » opens the same line, not the whole day.
    expect(screen.getByRole("link", { name: "Accord du patient" }).getAttribute("href")).toBe(courses);
    cleanup();

    renderPanel({ ...planningFixture().trips["trip-a"]!, patientPhone: null, mobility: null });
    expect(screen.getByText("Non renseigné")).toBeTruthy();
    expect(screen.queryByText("Mobilité")).toBeNull();
  });

  it("puts the trip's actions before its details (the panel scrolls in a short box)", () => {
    renderPanel(planningFixture().trips["trip-a"]!);
    const actions = screen.getByRole("group", { name: "Actions sur la course" });
    const phone = screen.getByText("Téléphone");
    expect(actions.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.contains(screen.getByRole("button", { name: /Figer/ }))).toBe(true);
    expect(actions.contains(moveSelect())).toBe(true);
  });

  it("says the margin before the appointment, and flags it under 5 minutes", () => {
    // RDV 07:30, dropped off at 07:20.
    renderPanel(planningFixture().trips["trip-a"]!);
    expect(screen.getByText(/· marge 10 min/)).toBeTruthy();
    cleanup();
    renderPanel({ ...planningFixture().trips["trip-a"]!, plannedDropoffMinute: 447 });
    expect(screen.getByText("Marge de 3 min avant le RDV (moins de 5 min)")).toBeTruthy();
    cleanup();
    renderPanel({ ...planningFixture().trips["trip-a"]!, plannedDropoffMinute: 455 });
    expect(screen.getByText("Dépose 5 min après le RDV")).toBeTruthy();
  });

  it("freezes with « F » and goes to « Déplacer vers… » with « D », not while typing", async () => {
    renderPanel(planningFixture().trips["trip-a"]!);
    fireEvent.keyDown(document.body, { key: "d" });
    expect(document.activeElement).toBe(moveSelect());
    // In the list, « f » is a letter for the list, not the shortcut.
    fireEvent.keyDown(moveSelect(), { key: "f" });
    expect(actions.lockTrip).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "F" });
    await waitFor(() => expect(actions.lockTrip).toHaveBeenCalledWith("trip-a", "taxi-1"));
    expect(screen.getByRole("button", { name: /Figer/ }).getAttribute("aria-keyshortcuts")).toBe("F");
  });

  it("closes from its button", () => {
    const { onClose } = renderPanel(planningFixture().trips["trip-a"]!);
    fireEvent.click(screen.getByRole("button", { name: "Fermer le détail de la course" }));
    expect(onClose).toHaveBeenCalled();
  });
});
