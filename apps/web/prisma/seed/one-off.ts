/**
 * One-off trips of the fictitious company (pure, unit-tested): consultations,
 * imaging, hospital admissions and discharges of occasional patients, and a
 * few private taxi clients. A real day mixes them with the series (dialysis,
 * radiotherapy, chemotherapy): they fill the hours between the sessions, when
 * the vehicles would otherwise wait. Used by the seed (the days of the seeded
 * fortnight) and by the history script (each simulated day).
 *
 * Each episode is one patient's care of the day: both legs (consultation,
 * imaging, private client), the outbound only (admission) or the return only
 * (discharge), with its own one-off prescription (isSeries false), except a
 * private client (payer PRIVATE, taxi only). Every share below is an
 * assumption of this fictitious data set, not a figure of V.
 */
import type { Mobility, Payer, PrescribedMode, Prisma, SharingScope, TripDirection } from "@prisma/client";
import { allowedVehicleTypesFor, formatAddress, initialSharingStatus, sharingAllowedFor } from "@/lib/domain/rules";
import { addDays, fromIsoDate, isoWeekday } from "@/lib/time";
import type { AnyFacilityKey, TownKey } from "./data";
import type { Rng } from "./random";

export type OneOffKind = "CONSULTATION" | "IMAGING" | "ADMISSION" | "DISCHARGE" | "PRIVATE";

/** Prefix of the ids of the seed's occasional patients: the history script draws its one-off trips from them. */
export const OCCASIONAL_ID_PREFIX = "occasional-";

/** A patient of the pool of occasional patients (no recurrence). */
export type OccasionalPatient = { id: string; mobility: Mobility; town: TownKey };

type Place = { address: string; lat: number; lng: number };

export type OneOffEpisode = {
  patientId: string;
  kind: OneOffKind;
  /** Care facility, or null for a private client (station, airport). */
  facilityKey: AnyFacilityKey | null;
  /** Station or airport of a private client, null otherwise. */
  place: Place | null;
  /** Legs of the day: both, the outbound only (admission) or the return only (discharge). */
  legs: readonly TripDirection[];
  /** OUTBOUND: arrival at the latest (appointment). */
  appointmentMinute: number | null;
  /** RETURN: pickup at the earliest (end of the consultation, discharge time). */
  readyMinute: number | null;
  payer: Payer;
  /** Prescribed mode (null for a private client). */
  mode: PrescribedMode | null;
  sharing: SharingScope | null;
  prescriber: string | null;
  /** Days before the date the one-off prescription was written, and days it stays valid after. */
  writtenDaysBefore: number;
  validDaysAfter: number;
  note: string;
};

// ---------------------------------------------------------------------------
// Volumes

/**
 * Episodes per weekday (Monday to Friday) for a base of `perWeekday`;
 * Saturday about a third (discharges, a few imaging slots), Sunday none.
 */
export const WEEKDAY_FACTOR: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 0.3, 7: 0 };

/**
 * Share of a day's one-off trips already booked `daysAhead` days before it:
 * all of them the day before (the regulator plans J+1 with every call
 * received), fewer further ahead (a consultation is booked a few days
 * before, a discharge the day before).
 */
export function bookedShare(daysAhead: number): number {
  if (daysAhead <= 1) return 1;
  return Math.max(0.25, 1 - 0.15 * (daysAhead - 1));
}

/** Number of episodes of `isoDate`: the weekday base, ± 15 %, times the booked share. */
export function episodeCount(perWeekday: number, isoDate: string, rng: Rng, booked = 1): number {
  const factor = WEEKDAY_FACTOR[isoWeekday(isoDate)] ?? 0;
  if (factor === 0) return 0;
  return Math.max(0, Math.round(perWeekday * factor * rng.float(0.85, 1.15) * booked));
}

// ---------------------------------------------------------------------------
// Where the occasional patients go

type Catchment = {
  consultation: readonly AnyFacilityKey[];
  imaging: readonly AnyFacilityKey[];
  hospital: readonly AnyFacilityKey[];
  /** Referral centres further away (specialist consultation, surgery). */
  referral: readonly AnyFacilityKey[];
};

/** Towns whose patients get their care and their trains in another town (suburbs, villages). */
type Satellite =
  | "allauch"
  | "aubagne"
  | "pennes"
  | "venelles"
  | "bouc"
  | "oraison"
  | "vinon"
  | "chateauArnoux"
  | "tallard"
  | "chorges"
  | "meylan"
  | "echirolles"
  | "vizille";
export type HubTown = Exclude<TownKey, Satellite>;

const HUB_OF: Record<Satellite, HubTown> = {
  allauch: "marseille",
  aubagne: "marseille",
  pennes: "marseille",
  venelles: "aix",
  bouc: "aix",
  oraison: "manosque",
  vinon: "manosque",
  chateauArnoux: "sisteron",
  tallard: "gap",
  chorges: "gap",
  meylan: "grenoble",
  echirolles: "grenoble",
  vizille: "grenoble",
};

/** Town whose facilities and station a patient living in `town` uses. */
export function hubOf(town: TownKey): HubTown {
  return town in HUB_OF ? HUB_OF[town as Satellite] : (town as HubTown);
}

/** Facilities of each town (towns without a facility use the nearest ones). */
export const CATCHMENTS: Record<HubTown, Catchment> = {
  marseille: { consultation: ["hospitalMarseille"], imaging: ["imagingMarseille"], hospital: ["hospitalMarseille"], referral: ["clinicAix"] },
  aix: { consultation: ["clinicAix"], imaging: ["clinicAix"], hospital: ["clinicAix"], referral: ["hospitalMarseille", "imagingMarseille"] },
  gardanne: { consultation: ["clinicAix"], imaging: ["clinicAix"], hospital: ["clinicAix"], referral: ["hospitalMarseille"] },
  pertuis: { consultation: ["clinicAix"], imaging: ["clinicAix"], hospital: ["clinicAix"], referral: ["hospitalMarseille"] },
  manosque: { consultation: ["hospitalManosque"], imaging: ["hospitalManosque"], hospital: ["hospitalManosque"], referral: ["hospitalMarseille", "clinicAix"] },
  forcalquier: { consultation: ["hospitalManosque"], imaging: ["hospitalManosque"], hospital: ["hospitalManosque"], referral: ["clinicAix"] },
  sisteron: { consultation: ["hospitalGap", "hospitalManosque"], imaging: ["imagingSisteron"], hospital: ["hospitalGap"], referral: ["hospitalGrenoble", "hospitalMarseille"] },
  laragne: { consultation: ["hospitalGap"], imaging: ["imagingSisteron", "imagingGap"], hospital: ["hospitalGap"], referral: ["hospitalGrenoble"] },
  gap: { consultation: ["hospitalGap"], imaging: ["imagingGap"], hospital: ["hospitalGap"], referral: ["hospitalGrenoble", "hospitalMarseille"] },
  veynes: { consultation: ["hospitalGap"], imaging: ["imagingGap"], hospital: ["hospitalGap"], referral: ["hospitalGrenoble"] },
  grenoble: { consultation: ["hospitalGrenoble"], imaging: ["imagingGrenoble"], hospital: ["hospitalGrenoble"], referral: ["hospitalGap"] },
};

/** Stations and airport (real public places) a private client of each town is taken to or from. */
export const PRIVATE_PLACES: Record<HubTown, readonly Place[]> = {
  marseille: [
    { address: "Gare Saint-Charles, 13001 Marseille", lat: 43.30266, lng: 5.38044 },
    { address: "Aéroport Marseille Provence, 13700 Marignane", lat: 43.4393, lng: 5.2214 },
  ],
  aix: [{ address: "Gare d'Aix-en-Provence TGV, 13290 Aix-en-Provence", lat: 43.4553, lng: 5.3173 }],
  gardanne: [{ address: "Gare d'Aix-en-Provence TGV, 13290 Aix-en-Provence", lat: 43.4553, lng: 5.3173 }],
  pertuis: [{ address: "Gare d'Aix-en-Provence TGV, 13290 Aix-en-Provence", lat: 43.4553, lng: 5.3173 }],
  manosque: [{ address: "Gare de Manosque - Gréoux-les-Bains, 04100 Manosque", lat: 43.8263, lng: 5.786 }],
  forcalquier: [{ address: "Gare de Manosque - Gréoux-les-Bains, 04100 Manosque", lat: 43.8263, lng: 5.786 }],
  sisteron: [{ address: "Gare de Sisteron, 04200 Sisteron", lat: 44.1931, lng: 5.9435 }],
  laragne: [{ address: "Gare de Sisteron, 04200 Sisteron", lat: 44.1931, lng: 5.9435 }],
  gap: [{ address: "Gare de Gap, 05000 Gap", lat: 44.5603, lng: 6.0721 }],
  veynes: [{ address: "Gare de Veynes - Dévoluy, 05400 Veynes", lat: 44.5333, lng: 5.8214 }],
  grenoble: [{ address: "Gare de Grenoble, 38000 Grenoble", lat: 45.1913, lng: 5.7146 }],
};

// ---------------------------------------------------------------------------
// Drawing the episodes of a day

/** Kinds by mobility (weights): a lying patient never takes a taxi, a wheelchair user is not a private client here. */
const KIND_WEIGHTS: Record<Mobility, readonly [OneOffKind, number][]> = {
  SEATED: [
    ["CONSULTATION", 0.42],
    ["IMAGING", 0.26],
    ["ADMISSION", 0.08],
    ["DISCHARGE", 0.1],
    ["PRIVATE", 0.14],
  ],
  WHEELCHAIR: [
    ["CONSULTATION", 0.45],
    ["IMAGING", 0.3],
    ["ADMISSION", 0.1],
    ["DISCHARGE", 0.15],
  ],
  LYING: [
    ["CONSULTATION", 0.2],
    ["IMAGING", 0.2],
    ["ADMISSION", 0.25],
    ["DISCHARGE", 0.35],
  ],
};

/** Share of the episodes that go to a referral centre further away. */
const REFERRAL_SHARE: Record<Exclude<OneOffKind, "PRIVATE">, number> = {
  CONSULTATION: 0.3,
  IMAGING: 0.15,
  ADMISSION: 0.5,
  DISCHARGE: 0.5,
};

const SPECIALTIES = [
  { prescriber: "Dr Hugo Ferrier — cardiologie", label: "cardiologie" },
  { prescriber: "Dr Sandrine Moretti — rhumatologie", label: "rhumatologie" },
  { prescriber: "Dr Karim Haddad — pneumologie", label: "pneumologie" },
  { prescriber: "Dr Élise Bonnaud — ophtalmologie", label: "ophtalmologie" },
  { prescriber: "Dr Marc Ravel — neurologie", label: "neurologie" },
] as const;
const GENERAL_PRACTITIONERS = ["Dr Agnès Rolland — médecine générale", "Dr Paul Siméon — médecine générale", "Dr Nora Benali — médecine générale"] as const;
const HOSPITAL_SERVICES = ["Service de chirurgie orthopédique", "Service de cardiologie", "Service de médecine interne", "Service de chirurgie digestive"] as const;

function weighted<T>(rng: Rng, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let draw = rng.float(0, total);
  for (const [item, weight] of items) {
    draw -= weight;
    if (draw < 0) return item;
  }
  const last = items[items.length - 1];
  if (!last) throw new Error("weighted() called on an empty list");
  return last[0];
}

/** Quarter-hour between `from` and `to` (minutes since midnight, both multiples of 15). */
function quarter(rng: Rng, from: number, to: number): number {
  return rng.int(from / 15, to / 15) * 15;
}

const h = (hours: number, minutes = 0) => hours * 60 + minutes;

/**
 * Time slots of the one-off care. The series fill the early morning (dialysis
 * at 07:30), the late morning (radiotherapy, long trips to Marseille and
 * Grenoble, dialysis returns at 11:30), the lunch hours (departures for
 * 13:00, breaks) and the evening (returns at 17:00): the hours the vehicles
 * have free are mostly in the afternoon, between the 13:00 drop-offs and the
 * 17:00 returns. Consultations and imaging are booked there three times out
 * of four (14:00 – 16:00), else early in the morning (08:30 – 09:30); a
 * referral centre further away at 14:00 – 14:30, to be home in the evening.
 * Admissions on the afternoon before an operation (or early morning),
 * discharges after the doctors' round.
 */
export const SLOTS = {
  morning: [h(8, 30), h(9, 30)],
  afternoon: [h(14), h(16)],
  referral: [h(14), h(14, 30)],
  admissionMorning: [h(8), h(9)],
  admissionAfternoon: [h(14), h(16)],
  discharge: [h(14), h(16, 30)],
  private: [h(7), h(18)],
} as const satisfies Record<string, readonly [number, number]>;

/** Share of the consultations, imaging and admissions booked in the morning slot. */
export const MORNING_SHARE = 0.25;

function slot(rng: Rng, [from, to]: readonly [number, number]): number {
  return quarter(rng, from, to);
}

/** Appointment of a consultation or an imaging slot: afternoon block mostly. */
function appointmentSlot(rng: Rng, referral: boolean): number {
  if (referral) return slot(rng, SLOTS.referral);
  return slot(rng, rng.chance(MORNING_SHARE) ? SLOTS.morning : SLOTS.afternoon);
}

/** Sharing written on a one-off TAP prescription: mostly allowed both ways (the norm since the 2025 decree). */
function drawSharing(rng: Rng): SharingScope {
  return weighted<SharingScope>(rng, [
    ["BOTH", 0.7],
    ["NONE", 0.2],
    ["OUTBOUND", 0.05],
    ["RETURN", 0.05],
  ]);
}

function drawEpisode(rng: Rng, patient: OccasionalPatient): OneOffEpisode {
  const kind = weighted(rng, KIND_WEIGHTS[patient.mobility]);
  if (kind === "PRIVATE") {
    const direction: TripDirection = rng.chance(0.5) ? "OUTBOUND" : "RETURN";
    const time = slot(rng, SLOTS.private);
    return {
      patientId: patient.id,
      kind,
      facilityKey: null,
      place: rng.pick(PRIVATE_PLACES[hubOf(patient.town)]),
      legs: [direction],
      appointmentMinute: direction === "OUTBOUND" ? time : null,
      readyMinute: direction === "RETURN" ? time : null,
      payer: "PRIVATE",
      mode: null,
      sharing: null,
      prescriber: null,
      writtenDaysBefore: 0,
      validDaysAfter: 0,
      note: direction === "OUTBOUND" ? "Client privé — départ en voyage, bagages." : "Client privé — retour de voyage, attente à l'arrivée.",
    };
  }

  const catchment = CATCHMENTS[hubOf(patient.town)];
  const referral = rng.chance(REFERRAL_SHARE[kind]);
  const local = kind === "CONSULTATION" ? catchment.consultation : kind === "IMAGING" ? catchment.imaging : catchment.hospital;
  const facilityKey = rng.pick(referral ? catchment.referral : local);
  const mode: PrescribedMode = patient.mobility === "LYING" ? "AMBULANCE" : "TAP";
  // An ambulance carries one patient: its prescriptions never allow sharing.
  const sharing = mode === "AMBULANCE" ? "NONE" : drawSharing(rng);
  const base = { patientId: patient.id, kind, facilityKey, place: null, payer: "CPAM" as const, mode, sharing };
  const written = { writtenDaysBefore: rng.int(1, 14), validDaysAfter: rng.int(0, 30) };

  switch (kind) {
    case "CONSULTATION": {
      const specialty = rng.pick(SPECIALTIES);
      const appointment = appointmentSlot(rng, referral);
      return {
        ...base,
        ...written,
        legs: ["OUTBOUND", "RETURN"],
        appointmentMinute: appointment,
        readyMinute: appointment + rng.pick([45, 60, 75, 90]),
        prescriber: specialty.prescriber,
        note: `Consultation de ${specialty.label} (ponctuelle).`,
      };
    }
    case "IMAGING": {
      const appointment = appointmentSlot(rng, referral);
      return {
        ...base,
        ...written,
        legs: ["OUTBOUND", "RETURN"],
        appointmentMinute: appointment,
        readyMinute: appointment + rng.pick([30, 45, 60]),
        prescriber: rng.pick(GENERAL_PRACTITIONERS),
        note: "Examen d'imagerie (ponctuel).",
      };
    }
    case "ADMISSION":
      return {
        ...base,
        ...written,
        legs: ["OUTBOUND"],
        appointmentMinute: slot(rng, rng.chance(MORNING_SHARE) ? SLOTS.admissionMorning : SLOTS.admissionAfternoon),
        readyMinute: null,
        prescriber: rng.pick(GENERAL_PRACTITIONERS),
        note: "Entrée en hospitalisation (aller simple).",
      };
    case "DISCHARGE":
      return {
        ...base,
        writtenDaysBefore: rng.int(0, 2),
        validDaysAfter: rng.int(0, 7),
        legs: ["RETURN"],
        appointmentMinute: null,
        readyMinute: slot(rng, referral ? SLOTS.referral : SLOTS.discharge),
        prescriber: rng.pick(HOSPITAL_SERVICES),
        note: "Sortie d'hospitalisation (retour à domicile).",
      };
  }
}

/**
 * The `count` episodes of a day: distinct patients of the pool (one care a
 * day each), drawn from `rng`, in a stable order. Fewer when the pool is smaller.
 */
export function drawEpisodes(pool: readonly OccasionalPatient[], count: number, rng: Rng): OneOffEpisode[] {
  const remaining = [...pool];
  const episodes: OneOffEpisode[] = [];
  while (episodes.length < count && remaining.length > 0) {
    const index = rng.int(0, remaining.length - 1);
    const [patient] = remaining.splice(index, 1);
    if (patient) episodes.push(drawEpisode(rng, patient));
  }
  return episodes;
}

/**
 * Share of lying patients (ambulance) among the occasional patients of a
 * town: the company takes the ambulance work its ambulances can reach (Gap
 * and Marseille in the small data set; Sisteron is 50 km from Gap), and
 * leaves the rest to other companies. Elsewhere, a few patients only.
 */
export const LYING_SHARE: Partial<Record<HubTown, number>> = { gap: 0.35, sisteron: 0.3, marseille: 0.12 };
export const DEFAULT_LYING_SHARE = 0.05;

/** The large fleet has ambulances at every depot: one occasional patient in six is lying, everywhere. */
export const FLEET_LYING_SHARE = 0.16;

/** Mobility of a patient of the pool living in `town`: mostly seated, lying as `lyingShare` says (LYING_SHARE by default). */
export function drawOccasionalMobility(rng: Rng, town: TownKey, lyingShare?: number): Mobility {
  const lying = lyingShare ?? LYING_SHARE[hubOf(town)] ?? DEFAULT_LYING_SHARE;
  return weighted<Mobility>(rng, [
    ["SEATED", 0.92 - lying],
    ["WHEELCHAIR", 0.08],
    ["LYING", lying],
  ]);
}

// ---------------------------------------------------------------------------
// Rows

/** The one-off prescription of an episode (null for a private client). */
export function episodePrescription(
  episode: OneOffEpisode,
  isoDate: string,
): Omit<Prisma.PrescriptionUncheckedCreateInput, "patientId"> | null {
  if (episode.payer === "PRIVATE" || !episode.mode || !episode.sharing) return null;
  return {
    mode: episode.mode,
    sharing: episode.sharing,
    validFrom: fromIsoDate(addDays(isoDate, -episode.writtenDaysBefore)),
    validTo: fromIsoDate(addDays(isoDate, episode.validDaysAfter)),
    isSeries: false,
    prescriber: episode.prescriber,
    notes: `PMT ponctuelle. ${episode.note}`,
  };
}

/**
 * The trips of an episode on `isoDate`, as Trip rows (without id): the
 * patient's home is the pickup of the outbound leg and the drop-off of the
 * return; sharing, vehicle types and sharing status follow lib/domain/rules.ts
 * like any trip created in the app.
 */
export function episodeTrips(
  episode: OneOffEpisode,
  home: { address: string; postalCode: string; city: string; lat: number; lng: number },
  destination: { id: string | null; address: string; lat: number; lng: number },
  isoDate: string,
  prescriptionId: string | null,
): Prisma.TripCreateManyInput[] {
  const homePlace = { address: formatAddress(home), lat: home.lat, lng: home.lng };
  const serviceDate = fromIsoDate(isoDate);
  return episode.legs.map((direction) => {
    const [pickup, dropoff] = direction === "OUTBOUND" ? [homePlace, destination] : [destination, homePlace];
    const sharingAllowed = sharingAllowedFor(episode.sharing, direction, episode.mode, episode.payer);
    return {
      serviceDate,
      direction,
      patientId: episode.patientId,
      prescriptionId,
      facilityId: destination.id,
      payer: episode.payer,
      allowedVehicleTypes: allowedVehicleTypesFor(episode.mode, episode.payer),
      pickupAddress: pickup.address,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      dropoffAddress: dropoff.address,
      dropoffLat: dropoff.lat,
      dropoffLng: dropoff.lng,
      appointmentMinute: direction === "OUTBOUND" ? episode.appointmentMinute : null,
      readyMinute: direction === "RETURN" ? episode.readyMinute : null,
      sharingAllowed,
      sharingStatus: initialSharingStatus(sharingAllowed),
      notes: episode.note,
    };
  });
}
