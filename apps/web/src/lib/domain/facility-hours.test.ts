import { describe, expect, it } from "vitest";
import {
  contractFacilityHours,
  dayHoursText,
  describeOpeningHours,
  facilityHoursOn,
  insideHours,
  outsideHoursText,
  parseOpeningHours,
} from "./facility-hours";

const WEEK = [
  { weekday: 1, openMinute: 420, closeMinute: 1140 },
  { weekday: 2, openMinute: 420, closeMinute: 1140 },
  { weekday: 3, openMinute: 420, closeMinute: 1140 },
  { weekday: 4, openMinute: 420, closeMinute: 1140 },
  { weekday: 5, openMinute: 420, closeMinute: 1140 },
  { weekday: 6, openMinute: 480, closeMinute: 720 },
];

describe("facility reception hours", () => {
  it("reads the stored JSON, dropping what it cannot use", () => {
    expect(
      parseOpeningHours([
        { weekday: 2, openMinute: 420, closeMinute: 1140 },
        { weekday: 3, openMinute: 600, closeMinute: 500 },
        { weekday: 8, openMinute: 420, closeMinute: 1140 },
        null,
      ]),
    ).toEqual([{ weekday: 2, openMinute: 420, closeMinute: 1140 }]);
    expect(parseOpeningHours("x")).toEqual([]);
  });

  it("gives the hours of the date's weekday, the earliest arrival in place of the opening", () => {
    // 2026-11-03 is a Tuesday, 2026-11-08 a Sunday.
    expect(facilityHoursOn({ openingHours: WEEK, earliestArrivalMinute: null }, "2026-11-03")).toEqual({ openMin: 420, closeMin: 1140 });
    expect(facilityHoursOn({ openingHours: WEEK, earliestArrivalMinute: 405 }, "2026-11-03")).toEqual({ openMin: 405, closeMin: 1140 });
    expect(facilityHoursOn({ openingHours: WEEK, earliestArrivalMinute: null }, "2026-11-08")).toBeNull();
    // A day without hours has no bound, the earliest arrival included (« Un jour sans horaire n'a pas de contrainte »).
    expect(facilityHoursOn({ openingHours: WEEK, earliestArrivalMinute: 405 }, "2026-11-08")).toBeNull();
    expect(facilityHoursOn({ openingHours: [], earliestArrivalMinute: null }, "2026-11-03")).toBeNull();
    // No hours at all: the earliest arrival holds every day.
    expect(facilityHoursOn({ openingHours: [], earliestArrivalMinute: 405 }, "2026-11-08")).toEqual({ openMin: 405, closeMin: null });
  });

  it("sends the bounds only for a trip whose own time is inside them", () => {
    const hours = { openMin: 420, closeMin: 1140 };
    expect(insideHours(hours, 450)).toBe(true);
    expect(contractFacilityHours(hours, 450)).toEqual({ facilityOpenMin: 420, facilityCloseMin: 1140 });
    expect(contractFacilityHours({ openMin: null, closeMin: 1140 }, 690)).toEqual({ facilityCloseMin: 1140 });
    expect(contractFacilityHours(hours, 400)).toEqual({});
    expect(contractFacilityHours(null, 450)).toEqual({});
    expect(outsideHoursText(hours, "OUTBOUND", 400)).toBe("RDV à 06:40, avant l'accueil (07:00)");
    expect(outsideHoursText(hours, "RETURN", 1150)).toBe("Fin de séance à 19:10, après la fermeture (19:00)");
    expect(outsideHoursText(hours, "OUTBOUND", 450)).toBeNull();
  });

  it("describes the week and the day", () => {
    expect(describeOpeningHours(WEEK)).toBe("Lun → Ven 07:00–19:00, Sam 08:00–12:00");
    expect(describeOpeningHours([WEEK[0]!, WEEK[1]!])).toBe("Lun Mar 07:00–19:00");
    expect(dayHoursText({ openMin: 405, closeMin: 1140 })).toBe("Accueil de 06:45 à 19:00");
    expect(dayHoursText({ openMin: 405, closeMin: null })).toBe("Accueil dès 06:45");
  });
});
