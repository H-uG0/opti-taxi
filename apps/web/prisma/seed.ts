/**
 * Development seed: wipes the database and loads a 100 % fictitious data set
 * (patients, facilities, fleet, staff, tariffs, accounts and two weeks of
 * trips) for the Marseille – Grenoble axis.
 *
 * Run with `pnpm db:seed` (prisma db seed -> tsx prisma/seed.ts). It must not
 * import "@/lib/db" or anything marked "server-only": it owns its client.
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
  type DriverDef,
  type DriverKey,
  type FacilityKey,
} from "./seed/data";
import { distanceKm, jitter } from "./seed/geo";
import {
  devEmail,
  fictitiousLandline,
  fictitiousMobile,
  NameFactory,
  randomAccessNote,
  streetAddress,
} from "./seed/identity";
import { Rng } from "./seed/random";

/** Fixed seed: every run produces the same people, places and schedules (dates stay relative to today). */
const RANDOM_SEED = 20_261_102;

const REGULATOR_ACCOUNT = { email: "regulateur@opti-taxi.test", password: "regulateur", name: "Régulation" };
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
// Safety: the seed erases everything, so it only runs against a local database.

/** Hosts considered local: this machine, or the PostgreSQL service of docker-compose. */
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/**
 * Refuses to run unless NODE_ENV is not "production" and DATABASE_URL points to
 * a local database (or SEED_ALLOW_WIPE=1 is set on purpose). Returns the target
 * ("database on host:port") for display; never the credentials.
 */
function assertDevelopmentDatabase(): string {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refus : le seed efface toute la base, il ne s'exécute jamais avec NODE_ENV=production.");
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("Refus : DATABASE_URL n'est pas défini, impossible de vérifier la base cible.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Refus : DATABASE_URL n'est pas une URL valide, impossible de vérifier la base cible.");
  }
  // A `host` query parameter (Unix socket) takes precedence over the URL host.
  const host = (url.searchParams.get("host") ?? url.hostname).toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "(base par défaut)";
  const target = `${database} sur ${host || "(hôte vide)"}${url.port ? `:${url.port}` : ""}`;
  if (!LOCAL_DATABASE_HOSTS.has(host) && process.env.SEED_ALLOW_WIPE !== "1") {
    throw new Error(
      `Refus : la base cible (${target}) n'est pas locale. Le seed efface toutes les données (patients, courses, comptes). ` +
        "Pour une base de développement distante, relancer avec SEED_ALLOW_WIPE=1.",
    );
  }
  return target;
}

// ---------------------------------------------------------------------------
// Reference data.

/** Deletes every row, children before parents (development database only). */
async function wipe(): Promise<void> {
  await prisma.$transaction([
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
    prisma.tariffGrid.deleteMany(),
    prisma.appSettings.deleteMany(),
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

async function seedDrivers(rng: Rng): Promise<Map<DriverKey, CreatedDriver>> {
  const drivers = new Map<DriverKey, CreatedDriver>();
  for (const key of Object.keys(DRIVERS) as DriverKey[]) {
    const def: DriverDef = DRIVERS[key];
    const created = await prisma.driver.create({
      data: {
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
async function seedVehicles(drivers: Map<DriverKey, CreatedDriver>): Promise<Map<DriverKey, string>> {
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

    const depot = DEPOTS[vehicle.depot];
    const location = depotLocation(depot);
    await prisma.vehicle.create({
      data: {
        label: vehicle.label,
        registration: vehicle.registration,
        type: vehicle.type,
        capacity: DEFAULT_CAPACITY[vehicle.type],
        depotLabel: depot.label,
        depotAddress: formatAddress({ address: depot.address, postalCode: depot.postalCode, city: TOWNS[depot.town].name }),
        depotLat: location.lat,
        depotLng: location.lng,
        department: depot.department,
        costPerKm: vehicle.costPerKm,
        defaultDriverId: driver.id,
        defaultCrewMateId: crewMate?.id ?? null,
      },
    });
    vehicleOfDriver.set(vehicle.driver, vehicle.label);
    if (vehicle.crewMate) vehicleOfDriver.set(vehicle.crewMate, vehicle.label);
  }
  return vehicleOfDriver;
}

async function seedUsers(
  drivers: Map<DriverKey, CreatedDriver>,
  vehicleOfDriver: Map<DriverKey, string>,
): Promise<DriverAccount[]> {
  await prisma.user.create({
    data: {
      email: REGULATOR_ACCOUNT.email,
      name: REGULATOR_ACCOUNT.name,
      passwordHash: await hashPassword(REGULATOR_ACCOUNT.password),
      role: "REGULATOR",
    },
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
  return accounts;
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
 */
async function seedSharingRefusals(dates: Dates): Promise<string[]> {
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
  for (const trip of chosen) {
    await prisma.trip.update({
      where: { id: trip.id },
      data: {
        sharingStatus: "REFUSED",
        sharingProposedAt: proposedAt,
        sharingRespondedAt: respondedAt,
        sharingNote: REFUSAL_NOTES[trip.direction],
      },
    });
  }
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
  const target = assertDevelopmentDatabase();
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
  console.log("• Chauffeurs, véhicules et comptes");
  const drivers = await seedDrivers(rng);
  const vehicleOfDriver = await seedVehicles(drivers);
  const accounts = await seedUsers(drivers, vehicleOfDriver);
  console.log("• Patients, prescriptions et récurrences");
  const names = new NameFactory(rng, Object.values(DRIVERS));
  await seedPatients(rng, names, facilities, dates);
  console.log(`• Courses générées du ${formatShortDate(dates.monday)} au ${formatShortDate(dates.lastDay)}`);
  const generated = await generateTrips(prisma, dates.monday, dates.lastDay);
  console.log(`  ${generated.created} courses créées (${generated.planned} prévues par les récurrences)`);
  console.log("• Courses ponctuelles de demain et refus de partage");
  const oneOff = await seedOneOffTrips(rng, names, facilities, dates);
  console.log(`  ${oneOff} courses ponctuelles`);
  const refusals = await seedSharingRefusals(dates);

  await printSummary(dates, refusals, accounts);
  console.log(`\nSeed terminé en ${((Date.now() - started) / 1000).toFixed(1)} s.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
