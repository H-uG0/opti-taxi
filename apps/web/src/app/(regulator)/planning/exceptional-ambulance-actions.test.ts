import { beforeEach, describe, expect, it, vi } from "vitest";

// « Recours exceptionnel à une ambulance » against a fake Prisma client and a
// fake computation: the proposal stays only with a plan that serves the trip
// there (saved, or waiting for confirmation); every other outcome puts the
// lock and the proposal back, traced, and says so. « Défiger » withdraws it.
const fake = vi.hoisted(() => {
  const models = {
    trip: { findUnique: vi.fn(), updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  return {
    db: { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) },
    runOptimization: vi.fn(),
    unassignedByLastPlan: vi.fn(),
    vslGrid: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake.db }));
vi.mock("@/lib/planning/run-optimization", () => ({
  replanBlocker: vi.fn(async () => null),
  optimizationInProgress: vi.fn(async () => false),
  runOptimization: fake.runOptimization,
  unassignedByLastPlan: fake.unassignedByLastPlan,
  withdrawLapsedProposals: vi.fn(),
  PLANNING_TX_OPTIONS: {},
  OPTIMIZATION_IN_PROGRESS_ERROR: "Calcul en cours.",
  NOT_PENDING_ERROR: "",
}));
vi.mock("@/lib/planning/version", () => ({ loadPlanVersion: vi.fn(async () => "v1"), STALE_PLAN_ERROR: "Le planning a changé." }));
vi.mock("@/lib/optimizer/build-request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/optimizer/build-request")>()),
  loadDayVehicleInputs: vi.fn(async () => []),
  resolveVehicleAvailability: vi.fn(() => ({
    available: [{ id: "amb", label: "Ambulance 1", type: "AMBULANCE", department: "13" }],
    skipped: [],
  })),
  loadExceptionalAmbulanceGrid: fake.vslGrid,
}));

const { proposeExceptionalAmbulance, unlockTrip } = await import("./actions");

const DATE = "2099-01-05";
const PROPOSAL_WRITE = { id: "t1", routeId: null, status: { in: ["PLANNED", "ASSIGNED"] } };

function auditedActions(): string[] {
  return fake.db.auditEvent.createMany.mock.calls.flatMap((call) => call[0].data.map((e: { action: string }) => e.action));
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.db.trip.findUnique.mockResolvedValue({
    id: "t1",
    serviceDate: new Date(`${DATE}T00:00:00.000Z`),
    status: "PLANNED",
    payer: "CPAM",
    allowedVehicleTypes: ["TAXI", "VSL"],
    lockedVehicleId: null,
    routeId: null,
    direction: "OUTBOUND",
    exceptionalAmbulanceAt: null,
    exceptionalAmbulanceById: null,
    patient: { firstName: "Jeanne", lastName: "Martin" },
  });
  fake.db.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.db.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.unassignedByLastPlan.mockResolvedValue(new Set(["t1"]));
  fake.vslGrid.mockResolvedValue({ id: "grid-vsl" });
});

describe("proposeExceptionalAmbulance", () => {
  it("keeps the proposal with the plan that serves the trip in the ambulance, its reason traced", async () => {
    fake.runOptimization.mockResolvedValue({ ok: true, runId: "r1", message: "Planning optimisé : 10/10 courses servies." });
    const result = await proposeExceptionalAmbulance("t1", "amb");
    expect(result).toEqual({
      ok: true,
      message: "Course de MARTIN Jeanne confiée à Ambulance 1 : recours exceptionnel, facturé au tarif VSL. Planning optimisé : 10/10 courses servies.",
    });
    expect(fake.db.trip.updateMany).toHaveBeenCalledTimes(1);
    expect(fake.db.trip.updateMany.mock.calls[0]![0]).toMatchObject({
      where: PROPOSAL_WRITE,
      data: { exceptionalAmbulanceById: "u1", lockedVehicleId: "amb" },
    });
    expect(fake.db.auditEvent.createMany.mock.calls[0]![0].data[0]).toMatchObject({
      action: "trip.exceptional_ambulance",
      details: { vehicleId: "amb", reason: "Recours exceptionnel à une ambulance (aucun taxi ni VSL disponible)" },
    });
    expect(fake.runOptimization.mock.calls[0]![2].move).toMatchObject({ tripId: "t1", vehicleId: "amb", previousLock: null });
  });

  it("withdraws the proposal when the optimizer cannot serve the trip in the ambulance", async () => {
    fake.runOptimization.mockResolvedValue({
      ok: false,
      moveRejected: true,
      error: "Déplacement refusé : Ambulance 1 ne peut pas servir l'aller de MARTIN Jeanne. Le planning n'a pas été modifié.",
    });
    // The refused move already put the lock back: only the proposal is left to withdraw.
    fake.db.trip.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const result = await proposeExceptionalAmbulance("t1", "amb");
    expect(result).toEqual({
      ok: false,
      error:
        "Déplacement refusé : Ambulance 1 ne peut pas servir l'aller de MARTIN Jeanne. Le planning n'a pas été modifié. " +
        "Le recours exceptionnel à Ambulance 1 est retiré : la course de MARTIN Jeanne reste sans véhicule.",
    });
    const proposedAt = fake.db.trip.updateMany.mock.calls[0]![0].data.exceptionalAmbulanceAt;
    expect(fake.db.trip.updateMany.mock.calls[2]![0]).toEqual({
      where: { id: "t1", routeId: null, exceptionalAmbulanceAt: proposedAt },
      data: { exceptionalAmbulanceAt: null, exceptionalAmbulanceById: null },
    });
    expect(auditedActions()).toEqual(["trip.exceptional_ambulance", "trip.exceptional_ambulance_withdrawn"]);
  });

  it("puts the lock and the proposal back when the computation fails, and says so", async () => {
    fake.runOptimization.mockResolvedValue({ ok: false, error: "Le service d'optimisation ne répond pas." });
    const result = await proposeExceptionalAmbulance("t1", "amb");
    expect(result).toEqual({
      ok: false,
      error: "Le service d'optimisation ne répond pas. Le recours exceptionnel à Ambulance 1 est retiré : la course de MARTIN Jeanne reste sans véhicule.",
    });
    // The lock written for the proposal, if still there and the trip still without a route.
    expect(fake.db.trip.updateMany.mock.calls[1]![0]).toEqual({
      where: { id: "t1", routeId: null, lockedVehicleId: "amb" },
      data: { lockedVehicleId: null },
    });
    expect(auditedActions()).toEqual(["trip.exceptional_ambulance", "trip.unlock", "trip.exceptional_ambulance_withdrawn"]);
  });

  it("keeps the proposal while its plan waits for the regulator's confirmation", async () => {
    fake.runOptimization.mockResolvedValue({ ok: false, needsConfirmation: true, error: "Remplacer quand même ?" });
    const result = await proposeExceptionalAmbulance("t1", "amb");
    expect(result).toEqual({ ok: false, needsConfirmation: true, error: "Remplacer quand même ?" });
    expect(fake.db.trip.updateMany).toHaveBeenCalledTimes(1);
    expect(auditedActions()).toEqual(["trip.exceptional_ambulance"]);
  });

  it("tries to withdraw it when the computation throws, and asks to reload", async () => {
    fake.runOptimization.mockRejectedValue(new Error("boom"));
    const result = await proposeExceptionalAmbulance("t1", "amb");
    expect(result).toMatchObject({ ok: false, stale: true });
    expect(result.ok ? "" : result.error).toMatch(/^Recours à Ambulance 1 interrompu \(erreur inattendue\)\. Le recours exceptionnel à Ambulance 1 est retiré/);
    expect(auditedActions()).toEqual(["trip.exceptional_ambulance", "trip.unlock", "trip.exceptional_ambulance_withdrawn"]);
  });

  it("is refused before any write when the last optimization did not leave the trip unassigned", async () => {
    fake.unassignedByLastPlan.mockResolvedValue(new Set());
    const result = await proposeExceptionalAmbulance("t1", "amb");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^Optimisez d'abord la journée/) });
    expect(fake.db.trip.updateMany).not.toHaveBeenCalled();
    expect(fake.runOptimization).not.toHaveBeenCalled();
  });

  it("is refused without a VSL grid in force that day: it could not be billed at the VSL tariff", async () => {
    fake.vslGrid.mockResolvedValue(undefined);
    const result = await proposeExceptionalAmbulance("t1", "amb");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^Aucune grille VSL en vigueur le .* : créez-la dans Grilles tarifaires/) });
    expect(fake.db.trip.updateMany).not.toHaveBeenCalled();
  });
});

describe("unlockTrip", () => {
  it("withdraws an exceptional ambulance with the lock, and says so", async () => {
    const result = await unlockTrip("t1");
    expect(result).toEqual({
      ok: true,
      message:
        "Course défigée et recours exceptionnel à l'ambulance retiré : la prochaine optimisation la confiera à un taxi ou un VSL, ou la laissera sans véhicule.",
    });
    expect(fake.db.trip.updateMany.mock.calls[1]![0]).toEqual({
      where: { id: "t1", exceptionalAmbulanceAt: { not: null } },
      data: { exceptionalAmbulanceAt: null, exceptionalAmbulanceById: null },
    });
    expect(auditedActions()).toEqual(["trip.unlock", "trip.exceptional_ambulance_withdrawn"]);
  });

  it("says nothing of an exceptional ambulance the trip did not have", async () => {
    fake.db.trip.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const result = await unlockTrip("t1");
    expect(result).toEqual({ ok: true, message: "Course défigée : la prochaine optimisation pourra la changer de véhicule." });
    expect(auditedActions()).toEqual(["trip.unlock"]);
  });
});
