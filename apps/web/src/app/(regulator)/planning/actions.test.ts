import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDayCrews, type StaffPerson } from "@/lib/staff/day-crews";
import { changeRouteCrew } from "./actions";

// « Changer l'équipage » against a fake Prisma client: a route changed
// meanwhile, a pair refused on its seat, the crew of the day written with the
// route (it must resolve without a blocking problem), the crews released, the
// people without an active account.
const fake = vi.hoisted(() => {
  const models = {
    route: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    driver: { findMany: vi.fn() },
    staffAbsence: { findMany: vi.fn() },
    crewIncompatibility: { findMany: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    dayCrew: { findMany: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
    user: { findMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  return { ...models, $transaction: vi.fn(async (fn: (tx: typeof models) => unknown) => fn(models)) };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/planning/run-optimization", () => ({
  // A validated day: « Changer l'équipage » is the way to change a crew.
  replanBlocker: vi.fn(async () => "Planning validé."),
  optimizationInProgress: vi.fn(async () => false),
  PLANNING_TX_OPTIONS: {},
  OPTIMIZATION_IN_PROGRESS_ERROR: "Calcul en cours.",
  NOT_PENDING_ERROR: "",
}));
vi.mock("@/lib/planning/version", () => ({ loadPlanVersion: vi.fn(async () => "v1"), STALE_PLAN_ERROR: "Le planning a changé." }));

const DATE = "2099-01-05";
const ROUTE = "route_amb";

const person = (id: string, qualifications: StaffPerson["qualifications"], shift: [number, number] = [360, 1080]): StaffPerson => ({
  id,
  firstName: id,
  lastName: id.toUpperCase(),
  active: true,
  workDays: [1, 2, 3, 4, 5],
  qualifications,
  depotId: "dep",
  shiftStartMinute: shift[0],
  shiftEndMinute: shift[1],
});

const PEOPLE = [
  person("drv", ["AUXILIARY"]),
  person("sick", ["DEA"]),
  person("dea", ["DEA"]),
  // 15:00 – 19:00: covers the rest of the route, but shares 3 h only with drv.
  person("eve", ["DEA"], [900, 1140]),
];

beforeEach(() => {
  vi.clearAllMocks();
  fake.route.findUnique.mockImplementation(async ({ select }: { select: Record<string, unknown> }) =>
    "stops" in select
      ? {
          id: ROUTE,
          vehicleId: "amb",
          driverId: "drv",
          crewMateId: "sick",
          startMinute: 930,
          endMinute: 1070,
          vehicle: { label: "Ambulance 1", type: "AMBULANCE" },
          stops: [{ sequence: 1, kind: "PICKUP", startMinute: 940, completedAt: null, trip: { status: "PLANNED" } }],
        }
      : { serviceDate: new Date(`${DATE}T00:00:00.000Z`) },
  );
  fake.route.findMany.mockResolvedValue([]);
  fake.route.updateMany.mockResolvedValue({ count: 1 });
  fake.driver.findMany.mockResolvedValue(PEOPLE);
  fake.staffAbsence.findMany.mockResolvedValue([
    { driverId: "sick", kind: "SICK", startDate: new Date(`${DATE}T00:00:00.000Z`), endDate: new Date(`${DATE}T00:00:00.000Z`) },
  ]);
  fake.crewIncompatibility.findMany.mockResolvedValue([]);
  fake.appSettings.findUnique.mockResolvedValue(null);
  fake.dayCrew.findMany.mockResolvedValue([]);
  fake.dayCrew.deleteMany.mockResolvedValue({ count: 0 });
  fake.dayCrew.upsert.mockResolvedValue({ id: "dc_amb" });
  fake.user.findMany.mockResolvedValue([{ driverId: "dea" }]);
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.$executeRaw.mockResolvedValue(1);
});

describe("changeRouteCrew", () => {
  it("writes the route and the crew of the day, which resolves without a blocking problem", async () => {
    const result = await changeRouteCrew(ROUTE, "drv", "dea", "v1");
    expect(result).toEqual({ ok: true, message: "Équipage de Ambulance 1 changé\u00a0: DEA dea voit la tournée sur sa feuille de route dès maintenant, SICK sick n'y a plus accès." });
    // Conditional on the crew read: a colleague's change in between makes it a no-op.
    expect(fake.route.updateMany).toHaveBeenCalledWith({
      where: { id: ROUTE, driverId: "drv", crewMateId: "sick" },
      data: { driverId: "drv", crewMateId: "dea" },
    });
    const written = fake.dayCrew.upsert.mock.calls[0]![0].create;
    expect(written).toMatchObject({ vehicleId: "amb", driverId: "drv", crewMateId: "dea", updatedById: "u1" });
    const plan = resolveDayCrews({
      date: DATE,
      vehicles: [{ id: "amb", label: "Ambulance 1", type: "AMBULANCE", active: true, depotId: "dep", defaultDriverId: null, defaultCrewMateId: null }],
      people: PEOPLE,
      absences: [{ driverId: "sick", kind: "SICK", startDate: DATE, endDate: DATE }],
      incompatibilities: [],
      saved: [{ vehicleId: written.vehicleId, driverId: written.driverId, crewMateId: written.crewMateId }],
    });
    expect(plan.crews[0]?.blocked).toBeNull();
    expect(fake.auditEvent.createMany.mock.calls[0]![0].data.map((e: { action: string }) => e.action)).toEqual([
      "route.crew_change",
      "day_crew.save",
    ]);
  });

  it("refuses a pair without enough shared working time, on the crew mate's seat", async () => {
    const result = await changeRouteCrew(ROUTE, "drv", "eve", "v1");
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { crewMate: "DRV drv et EVE eve n'ont que 3\u00a0h\u00a000 d'horaire commun (4\u00a0h\u00a000 au moins, Paramètres)." },
    });
    expect(fake.route.updateMany).not.toHaveBeenCalled();
    expect(fake.dayCrew.upsert).not.toHaveBeenCalled();
  });

  it("refuses the change when the route's crew changed meanwhile", async () => {
    fake.route.updateMany.mockResolvedValue({ count: 0 });
    const result = await changeRouteCrew(ROUTE, "drv", "dea", "v1");
    expect(result).toMatchObject({ ok: false, stale: true });
    expect(fake.dayCrew.upsert).not.toHaveBeenCalled();
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it("names the crews sent back to the proposal and the people without an active account", async () => {
    fake.user.findMany.mockResolvedValue([]);
    fake.dayCrew.findMany.mockResolvedValue([{ id: "dc_vsl", vehicleId: "vsl", vehicle: { label: "VSL 2" } }]);
    const result = await changeRouteCrew(ROUTE, "drv", "dea", "v1");
    expect(result).toEqual({
      ok: true,
      message:
        "Équipage de Ambulance 1 changé\u00a0: SICK sick n'y a plus accès. DEA dea n'a pas de compte actif\u00a0: transmettez-lui la tournée (Personnel, fiche de la personne)." +
        " L'équipage fixé de VSL 2 revient à la proposition automatique (page Équipages).",
    });
    expect(fake.dayCrew.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["dc_vsl"] } } });
  });
});
