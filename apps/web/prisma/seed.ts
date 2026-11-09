/**
 * Development seed: wipes the database and loads a 100 % fictitious data set
 * (patients, facilities, fleet, staff, tariffs, accounts and two weeks of
 * trips) for the Marseille – Grenoble axis.
 *
 * Run with `pnpm db:seed` (prisma db seed -> tsx prisma/seed.ts). It must not
 * import "@/lib/db" or anything marked "server-only": it owns its client.
 * Development only: it refuses a database that is not on this machine or that
 * holds accounts it did not create (prisma/safety.ts, SEED_ALLOW_WIPE=1 to force).
 */
import { PrismaClient, type PrescribedMode, type SharingScope, type TripDirection } from "@prisma/client";
import { hashPassword } from "@/lib/auth/password";
import {
  allowedVehicleTypesFor,
  DEFAULT_CAPACITY,
  formatAddress,
  initialSharingStatus,
  REQUIRED_QUALIFICATIONS,
  sharingAllowedFor,
} from "@/lib/domain/rules";
import { generateTrips } from "@/lib/domain/trip-generation";
import { logError } from "@/lib/log";
import {
  addDays,
  formatShortDate,
  fromIsoDate,
  isoWeekday,
  parseMinute,
  startOfIsoWeek,
  todayIso,
  toIsoDate,
  WEEKDAY_SHORT,
} from "@/lib/time";
import {
  area,
  BREAK_WINDOW,
  DEPOTS,
  depotLocation,
  DRIVERS,
  REPLACEMENT_DRIVER_DEPOTS,
  FACILITIES,
  facilityLocation,
  ONE_OFF_CONSULTATION,
  PATIENTS,
  PRIVATE_CLIENTS,
  TARIFFS,
  TOWNS,
  TREATMENTS,
  VEHICLES,
  type AreaKey,
  type DepotKey,
  type DriverDef,
  type DriverKey,
  type FacilityKey,
} from "./seed/data";
import { liftAuditGuard, restoreAuditGuard } from "./audit-guard";
import { assertSeedOnlyDatabase, UnsafeDatabaseError } from "./safety";
import { distanceKm, jitter } from "./seed/geo";
import {
  devEmail,
  fictitiousLandline,
  fictitiousMobile,
  NameFactory,
  randomAccessNote,
  SEED_EMAIL_DOMAIN,
  streetAddress,
} from "./seed/identity";
import { Rng } from "./seed/random";

/** Fixed seed: every run produces the same people, places and schedules (dates stay relative to today). */
const RANDOM_SEED = 20_261_102;

const REGULATOR_ACCOUNT = { email: `regulateur${SEED_EMAIL_DOMAIN}`, password: "regulateur", name: "Régulation" };
const DRIVER_PASSWORD = "chauffeur";

const prisma = new PrismaClient();

type Dates = { today: string; tomorrow: string; monday: string; nextMonday: string; lastDay: string };
type Place = { address: string; postalCode: string; city: string; lat: number; lng: number };
type CreatedFacility = Place & { id: string; name: string };
type CreatedDriver = { id: string; key: DriverKey; def: DriverDef };
type DriverAccount = { email: string; name: string; vehicle: string | null };

function minute(value: string): number {
  const parsed = parseMinute(value);
  if (parsed === null) throw new Error(`Heure invalide dans les données du seed : « ${value} »`);
  return parsed;
}

function homeIn(rng: Rng, key: AreaKey): Place {
  const zone = area(key);
  const point = jitter(rng, zone.centre, 0.1, zone.spreadKm);
  return { address: streetAddress(rng), postalCode: zone.postalCode, city: zone.city, ...point };
}

function lookup<K, V>(map: Map<K, V>, key: K, what: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`${what} inconnu dans les données du seed : ${String(key)}`);
  return value;
}

// ---------------------------------------------------------------------------
// Reference data.

/**
 * Deletes every row, children before parents (development database only:
 * main() runs the guard of prisma/safety.ts first). The audit trail goes too:
 * it only ever holds ids of rows deleted here. Its append-only trigger is
 * lifted for this transaction only (audit-guard.ts).
 */
async function wipe(): Promise<void> {
  await prisma.$transaction([
    liftAuditGuard(prisma),
    prisma.auditEvent.deleteMany(),
    prisma.fuelLog.deleteMany(),
    prisma.maintenanceDeadline.deleteMany(),
    prisma.vehicleUnavailability.deleteMany(),
    prisma.dayCrew.deleteMany(),
    prisma.staffAbsence.deleteMany(),
    prisma.crewIncompatibility.deleteMany(),
    prisma.routeStop.deleteMany(),
    prisma.trip.deleteMany(),
    prisma.route.deleteMany(),
    prisma.optimizationRun.deleteMany(),
    prisma.user.deleteMany(),
    prisma.vehicle.deleteMany(),
    prisma.recurrence.deleteMany(),
    prisma.prescription.deleteMany(),
    prisma.patient.deleteMany(),
    prisma.facility.deleteMany(),
    prisma.driver.deleteMany(),
    prisma.depot.deleteMany(),
    prisma.tariffGrid.deleteMany(),
    prisma.trafficZone.deleteMany(),
    prisma.appSettings.deleteMany(),
    restoreAuditGuard(prisma),
  ]);
}

async function seedSettingsAndTariffs(): Promise<void> {
  // Schema defaults: arrival up to 30 min before the appointment, pickup up to 15 min after the session, etc.
  // Regulation number in the 04 65 71 xx xx range reserved for fiction (see fictitiousLandline).
  await prisma.appSettings.create({ data: { id: 1, regulatorPhone: "04 65 71 00 00" } });
  await prisma.tariffGrid.createMany({
    data: TARIFFS.map((tariff) => ({
      ...tariff,
      validFrom: fromIsoDate(tariff.validFrom),
      validTo: tariff.validTo ? fromIsoDate(tariff.validTo) : null,
    })),
  });
}

async function seedFacilities(rng: Rng): Promise<Map<FacilityKey, CreatedFacility>> {
  const facilities = new Map<FacilityKey, CreatedFacility>();
  for (const key of Object.keys(FACILITIES) as FacilityKey[]) {
    const def = FACILITIES[key];
    const location = facilityLocation(def);
    const created = await prisma.facility.create({
      data: {
        name: def.name,
        type: def.type,
        address: def.address,
        postalCode: def.postalCode,
        city: TOWNS[def.town].name,
        lat: location.lat,
        lng: location.lng,
        phone: fictitiousLandline(rng),
        notes: def.notes,
      },
    });
    facilities.set(key, created);
  }
  return facilities;
}

async function seedDepots(): Promise<Map<DepotKey, string>> {
  const depots = new Map<DepotKey, string>();
  for (const key of Object.keys(DEPOTS) as DepotKey[]) {
    const def = DEPOTS[key];
    const location = depotLocation(def);
    const created = await prisma.depot.create({
      data: {
        name: def.label,
        address: formatAddress({ address: def.address, postalCode: def.postalCode, city: TOWNS[def.town].name }),
        lat: location.lat,
        lng: location.lng,
      },
    });
    depots.set(key, created.id);
  }
  return depots;
}

/** Depot of a driver: the one of the first vehicle they crew, else their replacement depot. */
function driverDepot(key: DriverKey): DepotKey | null {
  const vehicle = VEHICLES.find((v) => v.driver === key || v.crewMate === key);
  return vehicle?.depot ?? REPLACEMENT_DRIVER_DEPOTS[key] ?? null;
}

async function seedDrivers(rng: Rng, depots: Map<DepotKey, string>): Promise<Map<DriverKey, CreatedDriver>> {
  const drivers = new Map<DriverKey, CreatedDriver>();
  for (const key of Object.keys(DRIVERS) as DriverKey[]) {
    const def: DriverDef = DRIVERS[key];
    const depot = driverDepot(key);
    const created = await prisma.driver.create({
      data: {
        depotId: depot ? (depots.get(depot) ?? null) : null,
        firstName: def.firstName,
        lastName: def.lastName,
        phone: fictitiousMobile(rng),
        qualifications: [...def.qualifications],
        workDays: [...def.workDays],
        shiftStartMinute: minute(def.shift[0]),
        shiftEndMinute: minute(def.shift[1]),
        breakWindowStartMinute: minute(BREAK_WINDOW[0]),
        breakWindowEndMinute: minute(BREAK_WINDOW[1]),
        breakMinutes: def.breakMinutes,
        hourlyCost: def.hourlyCost,
      },
    });
    drivers.set(key, { id: created.id, key, def });
  }
  return drivers;
}

function hasOneOf(person: DriverDef, required: readonly string[]): boolean {
  return person.qualifications.some((qualification) => required.includes(qualification));
}

/** Vehicles with their default crew; refuses a crew that does not hold the qualifications of rules.ts. */
async function seedVehicles(
  drivers: Map<DriverKey, CreatedDriver>,
  depots: Map<DepotKey, string>,
): Promise<Map<DriverKey, string>> {
  const vehicleOfDriver = new Map<DriverKey, string>();
  for (const vehicle of VEHICLES) {
    const required = REQUIRED_QUALIFICATIONS[vehicle.type];
    const driver = lookup(drivers, vehicle.driver, "Chauffeur");
    const crewMate = vehicle.crewMate ? lookup(drivers, vehicle.crewMate, "Équipier") : null;
    if (!hasOneOf(driver.def, required.driver)) {
      throw new Error(`${vehicle.label} : ${driver.def.firstName} ${driver.def.lastName} n'a pas la qualification requise`);
    }
    if (required.crewMate && (!crewMate || !hasOneOf(crewMate.def, required.crewMate))) {
      throw new Error(`${vehicle.label} : équipier absent ou non qualifié`);
    }
    if (!required.crewMate && crewMate) throw new Error(`${vehicle.label} : pas d'équipier pour ce type de véhicule`);

    const depotId = depots.get(vehicle.depot);
    if (!depotId) throw new Error(`${vehicle.label} : dépôt « ${vehicle.depot} » inconnu`);
    await prisma.vehicle.create({
      data: {
        label: vehicle.label,
        registration: vehicle.registration,
        type: vehicle.type,
        capacity: DEFAULT_CAPACITY[vehicle.type],
        depotId,
        department: DEPOTS[vehicle.depot].department,
        costPerKm: vehicle.costPerKm,
        energy: vehicle.energy ?? "DIESEL",
        defaultDriverId: driver.id,
        defaultCrewMateId: crewMate?.id ?? null,
      },
    });
    vehicleOfDriver.set(vehicle.driver, vehicle.label);
    if (vehicle.crewMate) vehicleOfDriver.set(vehicle.crewMate, vehicle.label);
  }
  return vehicleOfDriver;
}

/**
 * Staff planning examples (lot 3), next week so the Équipages page shows them:
 * a taxi driver of Sisteron on leave Monday to Friday (no spare taxi driver in
 * Sisteron: the replacement comes from another depot), an ambulance driver of
 * Gap on call on Wednesday (replaced by Gap's spare DEA), and one pair of
 * people not to put in the same crew.
 */
async function seedStaffPlanning(drivers: Map<DriverKey, CreatedDriver>, dates: Dates): Promise<void> {
  const id = (key: DriverKey) => lookup(drivers, key, "Chauffeur").id;
  await prisma.staffAbsence.createMany({
    data: [
      {
        driverId: id("thomas"),
        kind: "LEAVE",
        startDate: fromIsoDate(dates.nextMonday),
        endDate: fromIsoDate(addDays(dates.nextMonday, 4)),
        note: "Congés posés en septembre.",
      },
      {
        driverId: id("franck"),
        kind: "ON_CALL",
        startDate: fromIsoDate(addDays(dates.nextMonday, 2)),
        endDate: fromIsoDate(addDays(dates.nextMonday, 2)),
        note: "Garde départementale 8 h – 20 h.",
      },
    ],
  });
  const [a, b] = [id("julien"), id("kevin")].sort();
  await prisma.crewIncompatibility.create({
    data: { driverAId: a!, driverBId: b!, note: "Ne pas mettre ensemble en équipage (à revoir avec la direction)." },
  });
}

/** Litres or kWh per 100 km, and price per unit, of the seeded fill-ups (fictitious). */
const FUEL_PROFILE = {
  TAXI: { per100Km: 6.2, price: 1.72 },
  VSL: { per100Km: 7.1, price: 1.72 },
  AMBULANCE: { per100Km: 10.8, price: 1.72 },
  ELECTRIC: { per100Km: 17.5, price: 0.26 },
} as const;

/**
 * Vehicle planning examples (lot 4): six weeks of fill-ups per vehicle, the
 * next technical inspection and insurance of each (one inspection due soon,
 * one service overdue on mileage), Taxi 1 in maintenance next Thursday and
 * Ambulance 2 on call next Wednesday (the day its driver is on call).
 */
async function seedFleetPlanning(rng: Rng, dates: Dates): Promise<void> {
  const vehicles = await prisma.vehicle.findMany({ select: { id: true, label: true, type: true, energy: true } });
  const byLabel = new Map(vehicles.map((v) => [v.label, v.id]));
  const idOf = (label: string) => {
    const id = byLabel.get(label);
    if (!id) throw new Error(`Véhicule « ${label} » inconnu`);
    return id;
  };
  const odometers = new Map<string, number>();
  for (const v of vehicles) {
    const profile = v.energy === "ELECTRIC" ? FUEL_PROFILE.ELECTRIC : FUEL_PROFILE[v.type];
    let km = rng.int(40, 160) * 1000;
    const fills = [];
    for (let day = -42; day <= -1; day += rng.int(5, 8)) {
      const driven = day === -42 ? 0 : rng.int(380, 720);
      km += driven;
      const quantity = day === -42 ? 40 : Math.round(((driven * profile.per100Km) / 100) * (0.92 + rng.float(0, 0.16)) * 10) / 10;
      fills.push({ vehicleId: v.id, date: fromIsoDate(addDays(dates.today, day)), odometerKm: km, quantity, cost: Math.round(quantity * profile.price * 100) / 100 });
    }
    await prisma.fuelLog.createMany({ data: fills });
    odometers.set(v.id, km);
    await prisma.maintenanceDeadline.createMany({
      data: [
        { vehicleId: v.id, kind: "INSPECTION", dueDate: fromIsoDate(addDays(dates.today, rng.int(60, 300))) },
        { vehicleId: v.id, kind: "INSURANCE", dueDate: fromIsoDate(addDays(dates.today, rng.int(90, 330))) },
      ],
    });
  }
  const taxi4 = idOf("Taxi 4 (Gap)");
  await prisma.maintenanceDeadline.updateMany({
    where: { vehicleId: taxi4, kind: "INSPECTION" },
    data: { dueDate: fromIsoDate(addDays(dates.today, 12)), note: "Rendez-vous à prendre au centre de Gap." },
  });
  const vsl2 = idOf("VSL 2 (Manosque)");
  await prisma.maintenanceDeadline.create({
    data: { vehicleId: vsl2, kind: "SERVICE", label: "Vidange + filtres", dueKm: (odometers.get(vsl2) ?? 0) - 300 },
  });
  await prisma.vehicleUnavailability.createMany({
    data: [
      {
        vehicleId: idOf("Taxi 1 (Marseille)"),
        kind: "MAINTENANCE",
        startDate: fromIsoDate(addDays(dates.nextMonday, 3)),
        endDate: fromIsoDate(addDays(dates.nextMonday, 3)),
        note: "Révision au garage de la Valentine.",
      },
      {
        vehicleId: idOf("Ambulance 2 (Gap)"),
        kind: "ON_CALL",
        startDate: fromIsoDate(addDays(dates.nextMonday, 2)),
        endDate: fromIsoDate(addDays(dates.nextMonday, 2)),
        note: "Garde départementale 8 h – 20 h.",
      },
    ],
  });
}

/** The regulator account (its id records the seeded sharing answers) and one account per driver. */
async function seedUsers(
  drivers: Map<DriverKey, CreatedDriver>,
  vehicleOfDriver: Map<DriverKey, string>,
): Promise<{ regulatorId: string; accounts: DriverAccount[] }> {
  const regulator = await prisma.user.create({
    data: {
      email: REGULATOR_ACCOUNT.email,
      name: REGULATOR_ACCOUNT.name,
      passwordHash: await hashPassword(REGULATOR_ACCOUNT.password),
      role: "REGULATOR",
    },
    select: { id: true },
  });
  const accounts: DriverAccount[] = [];
  for (const driver of drivers.values()) {
    const email = devEmail(driver.def.firstName, driver.def.lastName);
    const name = `${driver.def.firstName} ${driver.def.lastName}`;
    await prisma.user.create({
      data: { email, name, passwordHash: await hashPassword(DRIVER_PASSWORD), role: "DRIVER", driverId: driver.id },
    });
    accounts.push({ email, name, vehicle: vehicleOfDriver.get(driver.key) ?? null });
  }
  return { regulatorId: regulator.id, accounts };
}

// ---------------------------------------------------------------------------
// Patients, prescriptions and recurrences.

async function seedPatients(
  rng: Rng,
  names: NameFactory,
  facilities: Map<FacilityKey, CreatedFacility>,
  dates: Dates,
): Promise<void> {
  for (const spec of PATIENTS) {
    const treatment = TREATMENTS[spec.treatment];
    const facility = lookup(facilities, spec.facility, "Établissement");
    const mode: PrescribedMode = spec.mobility === "LYING" ? "AMBULANCE" : "TAP";
    // An ambulance carries one patient: its prescriptions never allow sharing.
    const sharing: SharingScope = mode === "AMBULANCE" ? "NONE" : spec.sharing;
    // Validity always covers at least today - 30 days .. today + 60 days.
    const validFrom = addDays(dates.today, -rng.int(30, 120));
    const validTo = addDays(dates.today, rng.int(60, 180));
    const endDate = spec.endsNextWeekOn ? addDays(dates.nextMonday, spec.endsNextWeekOn - 1) : null;

    const patient = await prisma.patient.create({
      data: {
        ...names.next(),
        phone: rng.chance(0.85) ? fictitiousMobile(rng) : null,
        ...homeIn(rng, spec.area),
        mobility: spec.mobility,
        accessNotes: spec.accessNotes ?? (rng.chance(0.3) ? randomAccessNote(rng) : null),
        active: spec.active ?? true,
        prescriptions: {
          create: {
            mode,
            sharing,
            validFrom: fromIsoDate(validFrom),
            validTo: fromIsoDate(validTo),
            isSeries: true,
            prescriber: treatment.prescriber,
            notes: spec.prescriptionNote ? `${treatment.notes} ${spec.prescriptionNote}` : treatment.notes,
          },
        },
      },
      select: { id: true, prescriptions: { select: { id: true } } },
    });
    const prescription = patient.prescriptions[0];
    if (!prescription) throw new Error("Prescription non créée");

    await prisma.recurrence.create({
      data: {
        patientId: patient.id,
        facilityId: facility.id,
        prescriptionId: prescription.id,
        label: treatment.label,
        weekdays: spec.weekdays,
        appointmentMinute: minute(spec.appointment),
        sessionMinutes: spec.sessionMinutes ?? treatment.sessionMinutes,
        legs: spec.legs ?? "BOTH",
        startDate: fromIsoDate(validFrom),
        endDate: endDate ? fromIsoDate(endDate) : null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// One-off trips for tomorrow and sharing refusals.

function legPlaces(direction: TripDirection, home: Place, care: { address: string; lat: number; lng: number }) {
  const homePlace = { address: formatAddress(home), lat: home.lat, lng: home.lng };
  const [pickup, dropoff] = direction === "OUTBOUND" ? [homePlace, care] : [care, homePlace];
  return {
    pickupAddress: pickup.address,
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    dropoffAddress: dropoff.address,
    dropoffLat: dropoff.lat,
    dropoffLng: dropoff.lng,
  };
}

/** Two private taxi clients and one CPAM consultation (both legs): 4 trips outside any recurrence. */
async function seedOneOffTrips(
  rng: Rng,
  names: NameFactory,
  facilities: Map<FacilityKey, CreatedFacility>,
  dates: Dates,
): Promise<number> {
  const serviceDate = fromIsoDate(dates.tomorrow);
  let created = 0;

  for (const client of PRIVATE_CLIENTS) {
    const home = homeIn(rng, client.area);
    const patient = await prisma.patient.create({
      data: {
        ...names.next(),
        phone: fictitiousMobile(rng),
        ...home,
        mobility: "SEATED",
        accessNotes: "Client privé (hors CPAM) : règlement à bord.",
      },
    });
    const sharingAllowed = sharingAllowedFor(null, client.direction, null, "PRIVATE");
    await prisma.trip.create({
      data: {
        serviceDate,
        direction: client.direction,
        patientId: patient.id,
        payer: "PRIVATE",
        allowedVehicleTypes: allowedVehicleTypesFor(null, "PRIVATE"),
        ...legPlaces(client.direction, home, client.place),
        appointmentMinute: client.direction === "OUTBOUND" ? minute(client.time) : null,
        readyMinute: client.direction === "RETURN" ? minute(client.time) : null,
        sharingAllowed,
        sharingStatus: initialSharingStatus(sharingAllowed),
        notes: client.notes,
      },
    });
    created++;
  }

  const consultation = ONE_OFF_CONSULTATION;
  const facility = lookup(facilities, consultation.facility, "Établissement");
  const home = homeIn(rng, consultation.area);
  const patient = await prisma.patient.create({
    data: {
      ...names.next(),
      phone: fictitiousMobile(rng),
      ...home,
      mobility: "SEATED",
      prescriptions: {
        create: {
          mode: "TAP",
          sharing: "BOTH",
          validFrom: fromIsoDate(dates.today),
          validTo: fromIsoDate(addDays(dates.today, 30)),
          isSeries: false,
          prescriber: consultation.prescriber,
          notes: consultation.notes,
        },
      },
    },
    select: { id: true, prescriptions: { select: { id: true, mode: true, sharing: true } } },
  });
  const prescription = patient.prescriptions[0];
  if (!prescription) throw new Error("Prescription non créée");

  const care = { address: formatAddress(facility), lat: facility.lat, lng: facility.lng };
  for (const direction of ["OUTBOUND", "RETURN"] as const) {
    const sharingAllowed = sharingAllowedFor(prescription.sharing, direction, prescription.mode, "CPAM");
    await prisma.trip.create({
      data: {
        serviceDate,
        direction,
        patientId: patient.id,
        prescriptionId: prescription.id,
        facilityId: facility.id,
        payer: "CPAM",
        allowedVehicleTypes: allowedVehicleTypesFor(prescription.mode, "CPAM"),
        ...legPlaces(direction, home, care),
        appointmentMinute: direction === "OUTBOUND" ? minute(consultation.appointment) : null,
        readyMinute: direction === "RETURN" ? minute(consultation.ready) : null,
        sharingAllowed,
        sharingStatus: initialSharingStatus(sharingAllowed),
        notes: consultation.notes,
      },
    });
    created++;
  }
  return created;
}

const REFUSAL_NOTES: Record<TripDirection, string> = {
  OUTBOUND: "Patient opposé au transport partagé à l'aller : souhaite voyager seul (refus recueilli par téléphone).",
  RETURN: "Patient opposé au transport partagé au retour : fatigue après la séance (refus recueilli par téléphone).",
};

/**
 * Homes at most this far apart (straight line) are neighbours: by the triangle
 * inequality, picking both up costs a detour of at most 2 x 3.5 km x 1.3 (road
 * factor of the optimizer's straight-line estimate) = 9.1 km, under the default
 * 10 km allowed per extra patient, whatever the pickup order.
 */
const NEIGHBOUR_KM = 3.5;

/**
 * Marks two of tomorrow's trips as REFUSED, chosen where the refusal matters:
 * the earliest outbound and the earliest return that had a natural sharing
 * partner (same facility, same time, sharing allowed, neighbouring home).
 * Recorded by the regulator account, with the audit event the « Courses »
 * action writes (trip.sharing_refuse), in the same transaction.
 */
async function seedSharingRefusals(dates: Dates, regulatorId: string): Promise<string[]> {
  const candidates = await prisma.trip.findMany({
    where: { serviceDate: fromIsoDate(dates.tomorrow), sharingAllowed: true, recurrenceId: { not: null } },
    include: { patient: { select: { firstName: true, lastName: true } }, facility: { select: { name: true } } },
  });
  type Candidate = (typeof candidates)[number];
  const timeOf = (trip: Candidate) => trip.appointmentMinute ?? trip.readyMinute ?? 0;
  // The patient's home is the pickup of an outbound leg and the drop-off of a return leg.
  const homeOf = (trip: Candidate) =>
    trip.direction === "OUTBOUND" ? { lat: trip.pickupLat, lng: trip.pickupLng } : { lat: trip.dropoffLat, lng: trip.dropoffLng };

  const groups = new Map<string, Candidate[]>();
  for (const trip of candidates) {
    const key = `${trip.facilityId}|${trip.direction}|${timeOf(trip)}`;
    groups.set(key, [...(groups.get(key) ?? []), trip]);
  }
  const hasNeighbour = (trip: Candidate, group: Candidate[]) =>
    group.some((other) => other.patientId !== trip.patientId && distanceKm(homeOf(trip), homeOf(other)) <= NEIGHBOUR_KM);
  // First trip (by patient name) of every group that has a real sharing partner, earliest first.
  const heads = [...groups.values()]
    .flatMap((group) =>
      group
        .filter((trip) => hasNeighbour(trip, group))
        .toSorted((a, b) => a.patient.lastName.localeCompare(b.patient.lastName, "fr"))
        .slice(0, 1),
    )
    .toSorted((a, b) => timeOf(a) - timeOf(b) || (a.facility?.name ?? "").localeCompare(b.facility?.name ?? "", "fr"));

  const chosen: Candidate[] = [];
  for (const direction of ["OUTBOUND", "RETURN"] as const) {
    const head = heads.find((trip) => trip.direction === direction && !chosen.some((c) => c.patientId === trip.patientId));
    if (head) chosen.push(head);
  }

  const proposedAt = new Date(Date.now() - 26 * 3_600_000);
  const respondedAt = new Date(Date.now() - 25 * 3_600_000);
  await prisma.$transaction([
    ...chosen.map((trip) =>
      prisma.trip.update({
        where: { id: trip.id },
        data: {
          sharingStatus: "REFUSED",
          sharingProposedAt: proposedAt,
          sharingRespondedAt: respondedAt,
          sharingRespondedById: regulatorId,
          sharingNote: REFUSAL_NOTES[trip.direction],
        },
      }),
    ),
    prisma.auditEvent.createMany({
      data: chosen.map((trip) => ({
        at: respondedAt,
        userId: regulatorId,
        role: "REGULATOR" as const,
        action: "trip.sharing_refuse",
        entity: "Trip",
        entityId: trip.id,
        serviceDate: trip.serviceDate,
      })),
    }),
  ]);
  return chosen.map(
    (trip) =>
      `${trip.patient.firstName} ${trip.patient.lastName} — ${trip.direction === "OUTBOUND" ? "aller" : "retour"}, ${trip.facility?.name ?? "sans établissement"}`,
  );
}

// ---------------------------------------------------------------------------
// Summary.

async function printSummary(dates: Dates, refusals: string[], accounts: DriverAccount[]): Promise<void> {
  const counts: [string, number][] = [
    ["Paramètres (AppSettings)", await prisma.appSettings.count()],
    ["Grilles tarifaires", await prisma.tariffGrid.count()],
    ["Établissements", await prisma.facility.count()],
    ["Chauffeurs", await prisma.driver.count()],
    ["Véhicules", await prisma.vehicle.count()],
    ["Utilisateurs", await prisma.user.count()],
    ["Patients", await prisma.patient.count()],
    ["Prescriptions", await prisma.prescription.count()],
    ["Récurrences", await prisma.recurrence.count()],
    ["Courses", await prisma.trip.count()],
    ["Événements d'audit", await prisma.auditEvent.count()],
  ];
  console.log("\nEnregistrements créés :");
  for (const [label, count] of counts) console.log(`  ${label.padEnd(26)} ${String(count).padStart(5)}`);

  const trips = await prisma.trip.findMany({
    select: { serviceDate: true, direction: true, allowedVehicleTypes: true, sharingAllowed: true, payer: true },
  });
  console.log(`\nCourses par jour, du ${formatShortDate(dates.monday)} au ${formatShortDate(dates.lastDay)} :`);
  console.log("  jour              aller retour total  ambulance partageables privées");
  for (let day = dates.monday; day <= dates.lastDay; day = addDays(day, 1)) {
    const ofDay = trips.filter((trip) => toIsoDate(trip.serviceDate) === day);
    const outbound = ofDay.filter((trip) => trip.direction === "OUTBOUND").length;
    const ambulance = ofDay.filter((trip) => trip.allowedVehicleTypes.includes("AMBULANCE")).length;
    const shareable = ofDay.filter((trip) => trip.sharingAllowed).length;
    const privateTrips = ofDay.filter((trip) => trip.payer === "PRIVATE").length;
    const marker = day === dates.tomorrow ? "  <- J+1" : "";
    console.log(
      `  ${WEEKDAY_SHORT[isoWeekday(day)]} ${formatShortDate(day)}  ${String(outbound).padStart(5)} ${String(ofDay.length - outbound).padStart(6)} ${String(ofDay.length).padStart(5)} ${String(ambulance).padStart(10)} ${String(shareable).padStart(12)} ${String(privateTrips).padStart(7)}${marker}`,
    );
  }

  console.log("\nRefus de partage tracés pour demain :");
  if (refusals.length === 0) console.log("  (aucune course partageable demain)");
  for (const refusal of refusals) console.log(`  ${refusal}`);

  console.log("\nComptes de développement (données fictives) :");
  console.log(`  Régulateur  ${REGULATOR_ACCOUNT.email}  mot de passe : ${REGULATOR_ACCOUNT.password}`);
  console.log(`  Chauffeurs  mot de passe : ${DRIVER_PASSWORD}`);
  for (const account of accounts) {
    console.log(`    ${account.email.padEnd(36)} ${account.name.padEnd(20)} ${account.vehicle ?? "remplaçant *"}`);
  }
  if (accounts.some((account) => account.vehicle === null)) {
    console.log(
      "  * Remplaçant : chauffeur attitré d'aucun véhicule. L'optimiseur ne l'utilise pas tant que le régulateur\n" +
        "    ne l'a pas désigné comme chauffeur d'un véhicule (page Véhicules).",
    );
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Before anything is written: a local database holding only the seed's accounts (prisma/safety.ts).
  const target = await assertSeedOnlyDatabase("seed", (where) => prisma.user.count({ where }));
  const started = Date.now();
  const rng = new Rng(RANDOM_SEED);
  const today = todayIso();
  const monday = startOfIsoWeek(today);
  const dates: Dates = {
    today,
    tomorrow: addDays(today, 1),
    monday,
    nextMonday: addDays(monday, 7),
    lastDay: addDays(monday, 13),
  };
  console.log(`Seed Opti-Taxi (données fictives) — aujourd'hui ${formatShortDate(today)}, demain ${formatShortDate(dates.tomorrow)}`);

  console.log(`Base cible : ${target}`);
  console.log("• Effacement des données existantes");
  await wipe();
  console.log("• Paramètres et grilles tarifaires");
  await seedSettingsAndTariffs();
  console.log("• Établissements");
  const facilities = await seedFacilities(rng);
  console.log("• Dépôts, chauffeurs, véhicules et comptes");
  const depots = await seedDepots();
  const drivers = await seedDrivers(rng, depots);
  const vehicleOfDriver = await seedVehicles(drivers, depots);
  await seedStaffPlanning(drivers, dates);
  // Own generator: the patients and trips drawn afterwards stay those of the earlier seeds.
  await seedFleetPlanning(new Rng(RANDOM_SEED + 4), dates);
  const { regulatorId, accounts } = await seedUsers(drivers, vehicleOfDriver);
  console.log("• Patients, prescriptions et récurrences");
  const names = new NameFactory(rng, Object.values(DRIVERS));
  await seedPatients(rng, names, facilities, dates);
  console.log(`• Courses générées du ${formatShortDate(dates.monday)} au ${formatShortDate(dates.lastDay)}`);
  const generated = await generateTrips(prisma, dates.monday, dates.lastDay);
  console.log(`  ${generated.created} courses créées (${generated.planned} prévues par les récurrences)`);
  console.log("• Courses ponctuelles de demain et refus de partage");
  const oneOff = await seedOneOffTrips(rng, names, facilities, dates);
  console.log(`  ${oneOff} courses ponctuelles`);
  const refusals = await seedSharingRefusals(dates, regulatorId);

  await printSummary(dates, refusals, accounts);
  console.log(`\nSeed terminé en ${((Date.now() - started) / 1000).toFixed(1)} s.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    // A refusal of the guard is expected: its message alone, without a stack trace.
    // Anything else is logged without the Prisma query arguments (addresses, notes).
    if (error instanceof UnsafeDatabaseError) console.error(`\n${error.message}`);
    else logError("[seed] le seed a échoué", error);
    await prisma.$disconnect();
    process.exit(1);
  });
