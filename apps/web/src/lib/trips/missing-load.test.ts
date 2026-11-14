import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromIsoDate } from "@/lib/time";
import { loadRecurrencesWithoutTrip } from "./missing-load";

// missing-load.ts against a fake Prisma client that applies the date filter it is given: which trips
// count as serving the day's session.
const fake = vi.hoisted(() => ({ recurrence: { findMany: vi.fn() }, trip: { findMany: vi.fn() } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: fake }));

const PLACE = { address: "1 rue A", postalCode: "13001", city: "Marseille", lat: 43.3, lng: 5.4 };
// Tuesday 10 November 2026: a session of the recurrence (Tuesdays).
const DATE = "2026-11-10";

function rec(id: string, lastName: string) {
  return {
    id,
    patientId: `pat_${id}`,
    facilityId: "f1",
    prescriptionId: `rx_${id}`,
    label: "Dialyse",
    weekdays: [2],
    appointmentMinute: 450,
    sessionMinutes: 240,
    legs: "BOTH" as const,
    startDate: fromIsoDate("2026-01-01"),
    endDate: null,
    active: true,
    patient: { ...PLACE, active: true, firstName: "Jean", lastName, prescriptions: [] },
    facility: { ...PLACE, name: "Centre" },
    prescription: { mode: "TAP" as const, sharing: "BOTH" as const, validFrom: fromIsoDate("2026-01-01"), validTo: fromIsoDate("2027-01-01") },
  };
}

type TripRow = { recurrenceId: string; serviceDate: Date; occurrenceDate: Date };

/** r1's Tuesday trip was moved to Wednesday; r2's Monday trip was moved to Tuesday; r3 has no trip at all. */
const TRIPS: TripRow[] = [
  { recurrenceId: "r1", serviceDate: fromIsoDate("2026-11-11"), occurrenceDate: fromIsoDate(DATE) },
  { recurrenceId: "r2", serviceDate: fromIsoDate(DATE), occurrenceDate: fromIsoDate("2026-11-09") },
];

beforeEach(() => {
  vi.clearAllMocks();
  fake.recurrence.findMany.mockResolvedValue([rec("r1", "Martin"), rec("r2", "Durand"), rec("r3", "Bernard")]);
  fake.trip.findMany.mockImplementation(async ({ where }: { where: Partial<Record<"serviceDate" | "occurrenceDate", Date>> }) =>
    TRIPS.filter((t) =>
      (["serviceDate", "occurrenceDate"] as const).every((key) => where[key] === undefined || t[key].getTime() === where[key]!.getTime()),
    ).map(({ recurrenceId }) => ({ recurrenceId })),
  );
});

describe("loadRecurrencesWithoutTrip", () => {
  it("counts a session whose trip was moved away as served, and never a trip moved in from another session", async () => {
    const missing = await loadRecurrencesWithoutTrip(DATE);
    expect(missing.map((m) => m.recurrenceId)).toEqual(["r3", "r2"]);
  });
});
