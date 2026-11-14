import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, fromIsoDate, todayIso } from "@/lib/time";
import { IDLE_STATE } from "@/lib/forms";
import { updateTrip } from "./actions";

// « Modifier la course » against a fake Prisma client: what is checked, written, traced and recomputed.
const fake = vi.hoisted(() => {
  const models = {
    trip: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    facility: { findUnique: vi.fn() },
    recurrence: { findUnique: vi.fn() },
    routeStop: { findMany: vi.fn(), deleteMany: vi.fn(), update: vi.fn() },
    appSettings: { upsert: vi.fn(), findUnique: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  const client = { ...models, $queryRaw: vi.fn() };
  return {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => unknown) => fn(client)),
    refreshRoutes: vi.fn(),
    geocoderEnabled: vi.fn(() => false),
    searchAddress: vi.fn(),
    redirect: vi.fn((href: string) => {
      throw new Error(`REDIRECT ${href}`);
    }),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: fake.redirect }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u1", name: "Régulation", role: "REGULATOR", driverId: null })),
}));
vi.mock("@/lib/db", () => ({ db: fake }));
vi.mock("@/lib/optimizer/client", () => ({ evaluate: vi.fn() }));
vi.mock("@/lib/geocode", async (original) => {
  const actual = await original<typeof import("@/lib/geocode")>();
  return { ...actual, geocoderEnabled: fake.geocoderEnabled, searchAddress: fake.searchAddress, allowGeocodeSearch: () => true };
});
vi.mock("@/lib/planning/refresh-routes", async (original) => {
  const actual = await original<typeof import("@/lib/planning/refresh-routes")>();
  return { ...actual, refreshRoutes: fake.refreshRoutes };
});

const TOMORROW = addDays(todayIso(), 1);
const LATER = addDays(todayIso(), 2);
const HOME = { address: "4 avenue Jean Jaurès", postalCode: "04100", city: "Manosque", lat: 43.8297, lng: 5.7864 };
const HOME_TEXT = "4 avenue Jean Jaurès, 04100 Manosque";
const CLINIC = { id: "f1", active: true, address: "1 rue de l'Hôpital", postalCode: "04100", city: "Manosque", lat: 43.83, lng: 5.79 };
const CLINIC_TEXT = "1 rue de l'Hôpital, 04100 Manosque";

/** A recurring outbound trip of tomorrow as updateTrip reads it. */
function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    status: "PLANNED",
    serviceDate: fromIsoDate(TOMORROW),
    occurrenceDate: fromIsoDate(TOMORROW),
    recurrenceId: "r1",
    direction: "OUTBOUND",
    payer: "CPAM",
    patientId: "p1",
    prescriptionId: "pre1",
    facilityId: "f1",
    allowedVehicleTypes: ["TAXI", "VSL"],
    sharingAllowed: true,
    sharingStatus: "NOT_PROPOSED",
    shared: false,
    appointmentMinute: 450,
    readyMinute: null,
    pickupAddress: HOME_TEXT,
    pickupLat: HOME.lat,
    pickupLng: HOME.lng,
    dropoffAddress: CLINIC_TEXT,
    dropoffLat: CLINIC.lat,
    dropoffLng: CLINIC.lng,
    oneOffAddress: false,
    notes: null,
    routeId: null,
    lockedVehicleId: null,
    exceptionalAmbulanceAt: null,
    route: null,
    lockedVehicle: null,
    prescription: { validFrom: fromIsoDate("2026-01-01"), validTo: fromIsoDate("2099-12-31") },
    patient: HOME,
    ...overrides,
  };
}

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  const base = { serviceDate: TOMORROW, time: "07:30", facilityId: "f1", homeMode: "home", notes: "" };
  for (const [key, value] of Object.entries({ ...base, ...entries })) fd.set(key, value);
  return fd;
}

async function submit(entries: Record<string, string>) {
  try {
    return { state: await updateTrip("t1", IDLE_STATE, form(entries)), href: null };
  } catch (error) {
    const match = /^REDIRECT (.*)$/.exec((error as Error).message);
    if (!match) throw error;
    return { state: null, href: match[1]! };
  }
}

function written() {
  return fake.trip.updateMany.mock.calls.map((call) => call[0] as { where: Record<string, unknown>; data: Record<string, unknown> });
}

function traced() {
  return fake.auditEvent.createMany.mock.calls.flatMap((call) => (call[0] as { data: { action: string; details?: unknown }[] }).data);
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.trip.findUnique.mockResolvedValue(stored());
  fake.trip.findFirst.mockResolvedValue(null);
  fake.trip.findMany.mockResolvedValue([]);
  fake.trip.updateMany.mockResolvedValue({ count: 1 });
  fake.facility.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "f1" ? CLINIC : where.id === "f2" ? { ...CLINIC, id: "f2", city: "Digne-les-Bains", lat: 44.1, lng: 6.24 } : null,
  );
  // No session of its own on the other days by default: a move is free.
  fake.recurrence.findUnique.mockResolvedValue({ active: true, weekdays: [], intervalWeeks: 1, sessionDates: [], legs: "BOTH", startDate: fromIsoDate("2026-01-01"), endDate: null });
  fake.routeStop.findMany.mockResolvedValue([]);
  fake.$queryRaw.mockResolvedValue([]);
  fake.appSettings.upsert.mockResolvedValue({ id: 1, waitBeforeAppointmentMin: 30, waitAfterSessionMin: 30, maxTotalWaitMin: 45 });
  fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
  fake.refreshRoutes.mockResolvedValue({ refreshed: 0, kept: 0, violations: 0, unavailable: false, failed: false, dayStarted: false });
  fake.geocoderEnabled.mockReturnValue(false);
});

describe("updateTrip (« Modifier la course »)", () => {
  it("writes the notes only, traced with the field names and never their text", async () => {
    const { href } = await submit({ notes: "Salle 3, apporter le coussin" });

    expect(written()).toEqual([
      { where: { id: "t1", status: "PLANNED", routeId: null, serviceDate: fromIsoDate(TOMORROW) }, data: { notes: "Salle 3, apporter le coussin" } },
    ]);
    expect(traced()).toEqual([expect.objectContaining({ action: "trip.update", details: { fields: ["notes"] } })]);
    expect(JSON.stringify(traced())).not.toContain("coussin");
    expect(href).toBe(`/courses?date=${TOMORROW}&notice=updated&course=t1&modif=notes`);
  });

  it("says when nothing changed, writing nothing", async () => {
    const { state } = await submit({});
    expect(state?.message).toMatch(/Aucune modification/);
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("takes a one-off address with typed coordinates, without geocoding, and keeps the link with the recurrence", async () => {
    const { href } = await submit({ homeMode: "other", homeAddress: "8 rue des Lilas, 04000 Digne-les-Bains", homeLat: "44,09", homeLng: "6,23" });
    const data = written()[0]!.data;
    expect(data).toMatchObject({ pickupAddress: "8 rue des Lilas, 04000 Digne-les-Bains", pickupLat: 44.09, pickupLng: 6.23, oneOffAddress: true });
    expect(data).not.toHaveProperty("recurrenceId");
    expect(href).toContain("modif=home");
  });

  it("keeps a one-off address shown again unchanged (coordinates printed with 6 decimals): notes only, the route kept", async () => {
    const away = { address: "8 rue des Lilas, 04000 Digne-les-Bains", lat: 44.09251234, lng: 6.23561234 };
    fake.trip.findUnique.mockResolvedValue(
      stored({
        oneOffAddress: true,
        pickupAddress: away.address,
        pickupLat: away.lat,
        pickupLng: away.lng,
        status: "ASSIGNED",
        routeId: "route1",
        route: { status: "PROPOSED", vehicle: { type: "TAXI", label: "Taxi 1" } },
      }),
    );
    await submit({ homeMode: "other", homeAddress: away.address, homeLat: "44.092512", homeLng: "6.235612", notes: "Sonner chez sa fille" });
    expect(written()[0]?.data).toEqual({ notes: "Sonner chez sa fille" });
    expect(fake.routeStop.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves the stored home side alone when « Domicile » stays chosen", async () => {
    fake.trip.findUnique.mockResolvedValue(stored({ patient: { ...HOME, address: "Nouveau domicile", lat: 43.9, lng: 5.9 } }));
    const { state } = await submit({});
    expect(state?.message).toMatch(/Aucune modification/);
  });

  it("refuses a one-off address it cannot locate (no geocoder), writing nothing", async () => {
    const { state } = await submit({ homeMode: "other", homeAddress: "8 rue des Lilas, 04000 Digne-les-Bains" });
    expect(state?.fieldErrors.homeLat).toMatch(/Géocodage indisponible/);
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("moves a routed trip to another day: out of its route, its routes recomputed, the session it serves kept", async () => {
    fake.trip.findUnique.mockResolvedValue(
      stored({ status: "ASSIGNED", routeId: "route1", route: { status: "PROPOSED", vehicle: { type: "TAXI", label: "Taxi 1" } } }),
    );
    fake.recurrence.findUnique.mockResolvedValue({ active: true, weekdays: [], intervalWeeks: 1, sessionDates: [], legs: "BOTH", startDate: fromIsoDate("2026-01-01"), endDate: null });
    fake.routeStop.findMany.mockImplementation(async ({ where }: { where: { tripId?: string } }) =>
      where.tripId ? [{ routeId: "route1" }] : [],
    );
    fake.$queryRaw.mockResolvedValue([{ id: "route1" }]);

    const { href } = await submit({ serviceDate: LATER });

    const data = written()[0]!.data;
    expect(data).toMatchObject({
      serviceDate: fromIsoDate(LATER),
      occurrenceDate: fromIsoDate(TOMORROW),
      routeId: null,
      status: "PLANNED",
    });
    expect(fake.routeStop.deleteMany).toHaveBeenCalledWith({ where: { tripId: "t1" } });
    expect(fake.refreshRoutes).toHaveBeenCalledWith(expect.anything(), ["route1"]);
    expect(traced()).toEqual([
      expect.objectContaining({
        action: "trip.update",
        details: { fields: ["date"], serviceDate: { from: TOMORROW, to: LATER }, detached: true },
      }),
    ]);
    expect(href).toBe(`/courses?date=${LATER}&notice=updated&course=t1&modif=date&retiree=1`);
  });

  it("refuses a day its recurrence already serves on the same leg", async () => {
    fake.recurrence.findUnique.mockResolvedValue({
      active: true,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      intervalWeeks: 1,
      sessionDates: [],
      legs: "BOTH",
      startDate: fromIsoDate("2026-01-01"),
      endDate: null,
    });
    fake.trip.findMany.mockResolvedValue([
      { status: "PLANNED", cancellationOrigin: null, serviceDate: fromIsoDate(LATER), occurrenceDate: fromIsoDate(LATER) },
    ]);

    const { state } = await submit({ serviceDate: LATER });

    expect(state?.fieldErrors.serviceDate).toMatch(/déjà une course/);
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
    expect(fake.trip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ serviceDate: fromIsoDate(LATER) }, { occurrenceDate: fromIsoDate(LATER) }] }),
      }),
    );
  });

  it("refuses a day another trip of the recurrence was moved to, and allows one whose session trip moved away", async () => {
    // Off the recurrence's days, but Monday's trip already went there.
    fake.trip.findMany.mockResolvedValue([
      { status: "PLANNED", cancellationOrigin: null, serviceDate: fromIsoDate(LATER), occurrenceDate: fromIsoDate(TOMORROW) },
    ]);
    const refused = await submit({ serviceDate: LATER });
    expect(refused.state?.fieldErrors.serviceDate).toMatch(/déjà une course/);

    // A day of the recurrence whose own trip was moved elsewhere: the day is free.
    fake.recurrence.findUnique.mockResolvedValue({
      active: true,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      intervalWeeks: 1,
      sessionDates: [],
      legs: "BOTH",
      startDate: fromIsoDate("2026-01-01"),
      endDate: null,
    });
    fake.trip.findMany.mockResolvedValue([
      { status: "PLANNED", cancellationOrigin: null, serviceDate: fromIsoDate(addDays(LATER, 1)), occurrenceDate: fromIsoDate(LATER) },
    ]);
    const { href } = await submit({ serviceDate: LATER });
    expect(href).toContain(`date=${LATER}`);
  });

  it("refuses a CPAM trip moved off its prescription when none covers the new day", async () => {
    fake.trip.findUnique.mockResolvedValue(
      stored({ recurrenceId: null, occurrenceDate: null, prescription: { validFrom: fromIsoDate("2026-01-01"), validTo: fromIsoDate(TOMORROW) } }),
    );
    const { state } = await submit({ serviceDate: LATER });
    // Its own PMT only, whatever the patient's other ones: the message says what to do instead.
    expect(state?.fieldErrors.serviceDate).toMatch(/La prescription de cette course ne couvre pas le .*\u00a0: annulez-la et créez une nouvelle course/);
    expect(fake.recurrence.findUnique).not.toHaveBeenCalled();
    expect(fake.trip.updateMany).not.toHaveBeenCalled();

    // A trip of a recurrence looks for the link of its series covering the day.
    fake.trip.findUnique.mockResolvedValue(stored({ prescription: { validFrom: fromIsoDate("2026-01-01"), validTo: fromIsoDate(TOMORROW) } }));
    fake.recurrence.findUnique.mockResolvedValue(null);
    const recurring = await submit({ serviceDate: LATER });
    expect(recurring.state?.fieldErrors.serviceDate).toMatch(/Aucune prescription de cette série de soins ne couvre/);
  });

  it("keeps a routed trip in its route when only its time changes and the planned stop still fits", async () => {
    fake.trip.findUnique.mockResolvedValue(
      stored({ status: "ASSIGNED", routeId: "route1", route: { status: "PROPOSED", vehicle: { type: "TAXI", label: "Taxi 1" } } }),
    );
    fake.trip.findMany.mockResolvedValue([
      {
        id: "t1",
        direction: "OUTBOUND",
        facilityId: "f1",
        appointmentMinute: 450,
        readyMinute: null,
        routeId: "route1",
        plannedPickupMinute: 400,
        plannedDropoffMinute: 440,
      },
    ]);

    const { href } = await submit({ time: "07:40" });

    expect(written()[0]?.data).toEqual({ appointmentMinute: 460 });
    expect(fake.routeStop.deleteMany).not.toHaveBeenCalled();
    expect(href).toBe(`/courses?date=${TOMORROW}&notice=updated&course=t1&modif=time`);
  });

  it("changes the facility of the session and refuses an unknown one", async () => {
    const { href } = await submit({ facilityId: "f2" });
    expect(written()[0]?.data).toMatchObject({ facilityId: "f2", dropoffLat: 44.1, dropoffLng: 6.24 });
    expect(href).toContain("modif=facility");

    vi.clearAllMocks();
    fake.trip.findUnique.mockResolvedValue(stored());
    fake.facility.findUnique.mockResolvedValue(null);
    const { state } = await submit({ facilityId: "f9" });
    expect(state?.fieldErrors.facilityId).toMatch(/introuvable/);
  });

  it("locates a one-off address whose text changed but whose coordinates are still the old point", async () => {
    const away = { address: "8 rue des Lilas, 04000 Digne-les-Bains", lat: 44.09251234, lng: 6.23561234 };
    fake.trip.findUnique.mockResolvedValue(stored({ oneOffAddress: true, pickupAddress: away.address, pickupLat: away.lat, pickupLng: away.lng }));
    const corrected = { homeMode: "other", homeAddress: "18 rue des Lilas, 04000 Digne-les-Bains", homeLat: "44.092512", homeLng: "6.235612" };

    // Without a geocoder: refused, rather than saved with the old point.
    const { state } = await submit(corrected);
    expect(state?.fieldErrors.homeLat).toMatch(/pas ses coordonnées/);
    expect(fake.trip.updateMany).not.toHaveBeenCalled();

    // With one: the new address is located.
    fake.geocoderEnabled.mockReturnValue(true);
    fake.searchAddress.mockResolvedValue({
      results: [{ label: corrected.homeAddress, address: "18 rue des Lilas", postalCode: "04000", city: "Digne-les-Bains", lat: 44.0931, lng: 6.2371, score: 0.9 }],
      outsideFrance: 0,
    });
    await submit(corrected);
    expect(fake.searchAddress).toHaveBeenCalledWith(corrected.homeAddress, 1);
    expect(written()[0]?.data).toMatchObject({ pickupAddress: corrected.homeAddress, pickupLat: 44.0931, pickupLng: 6.2371 });
  });

  it("does the same for the free care address of a private trip, and keeps coordinates typed anew", async () => {
    const free = { address: "Cabinet du Dr Martin, 04100 Manosque", lat: 43.831, lng: 5.789 };
    fake.trip.findUnique.mockResolvedValue(
      stored({ payer: "PRIVATE", facilityId: null, prescriptionId: null, prescription: null, dropoffAddress: free.address, dropoffLat: free.lat, dropoffLng: free.lng }),
    );
    const { state } = await submit({ facilityId: "", careAddress: "Cabinet du Dr Durand, 04100 Manosque", careLat: "43.831", careLng: "5.789" });
    expect(state?.fieldErrors.careLat).toMatch(/pas ses coordonnées/);

    await submit({ facilityId: "", careAddress: "Cabinet du Dr Durand, 04100 Manosque", careLat: "43.84", careLng: "5.8" });
    expect(written()[0]?.data).toMatchObject({ dropoffAddress: "Cabinet du Dr Durand, 04100 Manosque", dropoffLat: 43.84, dropoffLng: 5.8 });
  });

  it("keeps the exceptional ambulance, its lock and its route when only the notes change", async () => {
    fake.trip.findUnique.mockResolvedValue(
      stored({
        status: "ASSIGNED",
        routeId: "route1",
        route: { status: "VALIDATED", vehicle: { type: "AMBULANCE", label: "Ambulance 1" } },
        lockedVehicleId: "amb1",
        lockedVehicle: { type: "AMBULANCE" },
        exceptionalAmbulanceAt: new Date("2026-11-13T17:00:00Z"),
      }),
    );
    await submit({ notes: "Salle 5" });
    expect(written()[0]?.data).toEqual({ notes: "Salle 5" });
    expect(traced()).toEqual([expect.objectContaining({ action: "trip.update", details: { fields: ["notes"] } })]);
    expect(fake.routeStop.deleteMany).not.toHaveBeenCalled();
  });

  it("traces the lock and the exceptional ambulance a move to another day drops, and says so", async () => {
    fake.trip.findUnique.mockResolvedValue(
      stored({ lockedVehicleId: "amb1", lockedVehicle: { type: "AMBULANCE" }, exceptionalAmbulanceAt: new Date("2026-11-13T17:00:00Z") }),
    );
    const { href } = await submit({ serviceDate: LATER });
    expect(written()[0]).toMatchObject({
      where: { lockedVehicleId: "amb1" },
      data: { lockedVehicleId: null, exceptionalAmbulanceAt: null, exceptionalAmbulanceById: null },
    });
    expect(traced()).toEqual([
      expect.objectContaining({
        action: "trip.update",
        details: { fields: ["date"], serviceDate: { from: TOMORROW, to: LATER }, lockedVehicleId: { from: "amb1", to: null } },
      }),
      expect.objectContaining({ action: "trip.unlock", entityId: "t1" }),
      expect.objectContaining({ action: "trip.exceptional_ambulance_withdrawn", entityId: "t1" }),
    ]);
    expect(href).toContain("defigee=ambulance");

    vi.clearAllMocks();
    fake.trip.findUnique.mockResolvedValue(stored({ lockedVehicleId: "v1", lockedVehicle: { type: "TAXI" } }));
    fake.trip.updateMany.mockResolvedValue({ count: 1 });
    fake.auditEvent.createMany.mockResolvedValue({ count: 1 });
    const again = await submit({ serviceDate: LATER });
    expect(traced().map((event) => event.action)).toEqual(["trip.update", "trip.unlock"]);
    expect(again.href).toContain("defigee=1");
  });

  it("refuses a trip already started", async () => {
    fake.trip.findUnique.mockResolvedValue(stored({ status: "PICKED_UP" }));
    const { state } = await submit({ notes: "x" });
    expect(state?.message).toMatch(/ne peut plus être modifiée/);
    expect(fake.trip.updateMany).not.toHaveBeenCalled();
  });

  it("writes nothing when the trip changed meanwhile", async () => {
    fake.trip.updateMany.mockResolvedValue({ count: 0 });
    const { state } = await submit({ notes: "x" });
    expect(state?.message).toMatch(/changé entre-temps/);
    expect(fake.auditEvent.createMany).not.toHaveBeenCalled();
  });
});
