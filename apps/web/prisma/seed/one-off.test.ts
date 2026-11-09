import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/time";
import { OCCASIONAL_POOL_SIZE, ONE_OFF_EPISODES_PER_WEEKDAY, TOWNS, type TownKey } from "./data";
import {
  bookedShare,
  CATCHMENTS,
  DISCHARGE_TRIP_NOTE,
  drawEpisodes,
  drawOccasionalMobility,
  episodeCount,
  episodePrescription,
  episodeTrips,
  hubOf,
  planOneOffDays,
  PRIVATE_PLACES,
  privateClientEpisode,
  SLOTS,
  type OccasionalPatient,
} from "./one-off";
import { Rng } from "./random";

const HOME = { address: "3 rue des Lilas", postalCode: "05000", city: "Gap", lat: 44.56, lng: 6.08 };
const FACILITY = { id: "fac-1", address: "1 place des Mélèzes, 05000 Gap", lat: 44.57, lng: 6.08 };

function pool(count: number, mobility: OccasionalPatient["mobility"] = "SEATED", town: TownKey = "gap"): OccasionalPatient[] {
  return Array.from({ length: count }, (_, i) => ({ id: `occasional-${String(i + 1).padStart(4, "0")}`, mobility, town }));
}

describe("volumes", () => {
  it("books every one-off trip up to the day before, fewer further ahead", () => {
    expect(bookedShare(-3)).toBe(1);
    expect(bookedShare(1)).toBe(1);
    expect(bookedShare(2)).toBeCloseTo(0.85);
    expect(bookedShare(30)).toBe(0.25);
  });

  it("draws a weekday's count around the base, a third on Saturdays, none on Sundays", () => {
    const rng = new Rng(1);
    const monday = Array.from({ length: 50 }, () => episodeCount(20, "2026-11-09", rng));
    expect(Math.min(...monday)).toBeGreaterThanOrEqual(17);
    expect(Math.max(...monday)).toBeLessThanOrEqual(23);
    expect(episodeCount(20, "2026-11-14", new Rng(2))).toBeLessThanOrEqual(7);
    expect(episodeCount(20, "2026-11-15", new Rng(3))).toBe(0);
    expect(episodeCount(20, "2026-11-09", new Rng(4), 0.25)).toBeLessThanOrEqual(6);
  });
});

describe("one-off trips of the seeded fortnight", () => {
  // The small data set's pool (its random generators: one per `today`).
  const legsOn = (days: ReturnType<typeof planOneOffDays>, date: string) =>
    days.find((d) => d.date === date)?.episodes.reduce((sum, e) => sum + e.legs.length, 0) ?? 0;

  it("give J+1 about ONE_OFF_EPISODES_PER_WEEKDAY episodes, never more than the 10 vehicles take on top of the series", () => {
    const tomorrowLegs: number[] = [];
    // Every weekday of four weeks as « today »: J+1 from Tuesday to Saturday, then Monday.
    for (let offset = 0; offset < 28; offset++) {
      const today = addDays("2026-11-02", offset);
      const tomorrow = addDays(today, 1);
      const window = { from: addDays(today, -3), to: addDays(today, 10), today };
      const days = planOneOffDays(new Rng(offset + 1), pool(OCCASIONAL_POOL_SIZE), window, ONE_OFF_EPISODES_PER_WEEKDAY);
      const episodes = days.find((d) => d.date === tomorrow)?.episodes.length ?? 0;
      expect(episodes).toBeLessThanOrEqual(Math.round(ONE_OFF_EPISODES_PER_WEEKDAY * 1.15));
      tomorrowLegs.push(legsOn(days, tomorrow));
    }
    // About 8 trips a weekday at J+1 (12 at most): 13 with 8 episodes pushed 8 legs of the series out of the plan.
    expect(Math.max(...tomorrowLegs)).toBeLessThanOrEqual(12);
    const weekdays = tomorrowLegs.filter((legs) => legs > 0);
    expect(weekdays.reduce((sum, legs) => sum + legs, 0) / weekdays.length).toBeLessThan(10);
  });

  it("count the episodes a day already has (the private clients of tomorrow) in its volume, without moving the other days' draws", () => {
    const today = "2026-11-09";
    const window = { from: today, to: addDays(today, 6), today };
    const plain = planOneOffDays(new Rng(8), pool(OCCASIONAL_POOL_SIZE), window, ONE_OFF_EPISODES_PER_WEEKDAY);
    const booked = planOneOffDays(new Rng(8), pool(OCCASIONAL_POOL_SIZE), window, ONE_OFF_EPISODES_PER_WEEKDAY, new Map([["2026-11-10", 2]]));
    const count = (days: typeof plain, date: string) => days.find((d) => d.date === date)?.episodes.length ?? 0;
    expect(count(booked, "2026-11-10")).toBe(count(plain, "2026-11-10") - 2);
    expect(count(booked, "2026-11-09")).toBe(count(plain, "2026-11-09"));
    const client = { direction: "OUTBOUND" as const, place: PRIVATE_PLACES.aix[0]!, minute: 580, notes: "Client privé — train de 10 h 05." };
    const [trip] = episodeTrips(privateClientEpisode("p-1", client), HOME, { id: null, ...client.place }, "2026-11-10", null);
    expect(trip).toMatchObject({
      payer: "PRIVATE",
      appointmentMinute: 580,
      allowedVehicleTypes: ["TAXI"],
      notes: client.notes,
      prescriptionId: null,
    });
  });

  it("book fewer trips for the days further ahead, in the same draw whatever the days' order", () => {
    const today = "2026-11-09";
    const days = planOneOffDays(new Rng(3), pool(OCCASIONAL_POOL_SIZE), { from: today, to: addDays(today, 13), today }, 20);
    expect(days).toHaveLength(14);
    expect(days.find((d) => d.date === "2026-11-15")?.episodes).toEqual([]);
    const count = (date: string) => days.find((d) => d.date === date)?.episodes.length ?? 0;
    expect(count("2026-11-10")).toBeGreaterThan(count("2026-11-20"));
    expect(planOneOffDays(new Rng(3), pool(OCCASIONAL_POOL_SIZE), { from: today, to: addDays(today, 13), today }, 20)).toEqual(days);
  });
});

describe("episodes", () => {
  it("are deterministic and take each patient once a day", () => {
    const a = drawEpisodes(pool(30), 12, new Rng(7));
    const b = drawEpisodes(pool(30), 12, new Rng(7));
    expect(a).toEqual(b);
    expect(new Set(a.map((e) => e.patientId)).size).toBe(12);
    expect(drawEpisodes(pool(3), 12, new Rng(7))).toHaveLength(3);
  });

  it("send a lying patient by ambulance, never shared, never as a private client", () => {
    const episodes = drawEpisodes(pool(200, "LYING"), 200, new Rng(11));
    expect(episodes.every((e) => e.mode === "AMBULANCE" && e.sharing === "NONE" && e.payer === "CPAM")).toBe(true);
  });

  it("give each kind its legs and its slot, in the facilities of the patient's town or its referral centres", () => {
    const episodes = drawEpisodes(pool(400), 400, new Rng(5));
    const kinds = new Set(episodes.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["CONSULTATION", "IMAGING", "ADMISSION", "DISCHARGE", "PRIVATE"]));
    const within = (minute: number | null, [from, to]: readonly [number, number]) => minute !== null && minute >= from && minute <= to;
    const gap = CATCHMENTS.gap;
    for (const e of episodes) {
      if (e.kind === "PRIVATE") {
        expect(e.payer).toBe("PRIVATE");
        expect(e.facilityKey).toBeNull();
        expect(PRIVATE_PLACES.gap).toContain(e.place);
        expect(e.legs).toHaveLength(1);
        expect(episodePrescription(e, "2026-11-10")).toBeNull();
        continue;
      }
      expect([...gap.consultation, ...gap.imaging, ...gap.hospital, ...gap.referral]).toContain(e.facilityKey);
      if (e.kind === "ADMISSION") {
        expect(e.legs).toEqual(["OUTBOUND"]);
        expect(within(e.appointmentMinute, SLOTS.admissionMorning) || within(e.appointmentMinute, SLOTS.admissionAfternoon)).toBe(true);
      } else if (e.kind === "DISCHARGE") {
        expect(e.legs).toEqual(["RETURN"]);
        expect(within(e.readyMinute, SLOTS.discharge) || within(e.readyMinute, SLOTS.referral)).toBe(true);
      } else {
        expect(e.legs).toEqual(["OUTBOUND", "RETURN"]);
        expect(e.readyMinute! - e.appointmentMinute!).toBeGreaterThanOrEqual(30);
        expect(
          within(e.appointmentMinute, SLOTS.morning) || within(e.appointmentMinute, SLOTS.afternoon) || within(e.appointmentMinute, SLOTS.referral),
        ).toBe(true);
      }
    }
  });

  it("send the patients of a suburb to the facilities of its town", () => {
    expect(hubOf("aubagne")).toBe("marseille");
    expect(hubOf("chateauArnoux")).toBe("sisteron");
    expect(hubOf("gap")).toBe("gap");
    for (const town of Object.keys(TOWNS) as TownKey[]) expect(CATCHMENTS[hubOf(town)]).toBeDefined();
  });

  it("draw more lying patients near the ambulances, the share given otherwise", () => {
    const share = (town: TownKey, lying?: number) => {
      const rng = new Rng(9);
      const draws = Array.from({ length: 2000 }, () => drawOccasionalMobility(rng, town, lying));
      return draws.filter((m) => m === "LYING").length / draws.length;
    };
    expect(share("gap")).toBeGreaterThan(0.3);
    expect(share("pertuis")).toBeLessThan(0.08);
    expect(share("pertuis", 0.16)).toBeGreaterThan(0.13);
  });
});

describe("rows", () => {
  it("writes a one-off prescription valid on the day, and the legs with the rules of the app", () => {
    const [episode] = drawEpisodes(pool(1), 1, new Rng(3)).filter((e) => e.kind !== "PRIVATE");
    if (!episode) return;
    const prescription = episodePrescription(episode, "2026-11-10");
    expect(prescription).toMatchObject({ isSeries: false, mode: episode.mode });
    expect(new Date(String(prescription?.validFrom)).getTime()).toBeLessThanOrEqual(new Date("2026-11-10T00:00:00Z").getTime());
    expect(new Date(String(prescription?.validTo)).getTime()).toBeGreaterThanOrEqual(new Date("2026-11-10T00:00:00Z").getTime());

    const trips = episodeTrips(episode, HOME, FACILITY, "2026-11-10", "rx-1");
    expect(trips.map((t) => t.direction)).toEqual(episode.legs);
    for (const trip of trips) {
      expect(trip.prescriptionId).toBe("rx-1");
      expect(trip.facilityId).toBe("fac-1");
      expect(trip.allowedVehicleTypes).toEqual(episode.mode === "AMBULANCE" ? ["AMBULANCE"] : ["TAXI", "VSL"]);
      expect(trip.sharingStatus).toBe(trip.sharingAllowed ? "NOT_PROPOSED" : "NOT_ELIGIBLE");
      if (trip.direction === "OUTBOUND") expect(trip.pickupLat).toBe(HOME.lat);
      else expect(trip.dropoffLat).toBe(HOME.lat);
    }
  });

  it("keeps the reason of the care on the prescription, never in the trips' note the crew reads", () => {
    const episodes = drawEpisodes(pool(400, "SEATED"), 400, new Rng(13));
    const medical = /consultation|cardio|rhumato|pneumo|ophtalmo|neuro|imagerie|examen|hospitalisation|chirurgie|médecine/i;
    for (const episode of episodes) {
      const place = episode.place ?? FACILITY;
      for (const trip of episodeTrips(episode, HOME, { id: episode.place ? null : FACILITY.id, ...place }, "2026-11-10", "rx-1")) {
        if (trip.notes) expect(trip.notes).not.toMatch(medical);
      }
      if (episode.kind === "PRIVATE") continue;
      expect(episodePrescription(episode, "2026-11-10")?.notes).toMatch(medical);
    }
    expect(episodes.some((e) => e.kind === "DISCHARGE" && e.tripNote === DISCHARGE_TRIP_NOTE)).toBe(true);
  });

  it("sends a private client by taxi, without prescription nor sharing", () => {
    const privateEpisode = drawEpisodes(pool(300), 300, new Rng(21)).find((e) => e.kind === "PRIVATE");
    expect(privateEpisode).toBeDefined();
    if (!privateEpisode?.place) return;
    const [trip] = episodeTrips(privateEpisode, HOME, { id: null, ...privateEpisode.place }, "2026-11-10", null);
    expect(trip).toMatchObject({ payer: "PRIVATE", allowedVehicleTypes: ["TAXI"], sharingAllowed: false, facilityId: null, prescriptionId: null });
  });
});
