/**
 * French legal public holidays (Code du travail, art. L. 3133-1), the list the
 * « dimanche et jour férié » surcharge reads by default: no convention fixes
 * it (PO question). Alsace-Moselle days are not included. Pure module.
 */
import { addDays } from "@/lib/time";

export type Holiday = { date: string; label: string };

/** Easter Sunday of `year` (Gregorian computus, Meeus/Jones/Butcher), "YYYY-MM-DD". */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The 11 legal public holidays of `year`, in date order. */
export function frenchPublicHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  const fixed = (monthDay: string, label: string): Holiday => ({ date: `${year}-${monthDay}`, label });
  return [
    fixed("01-01", "Jour de l'an"),
    { date: addDays(easter, 1), label: "Lundi de Pâques" },
    fixed("05-01", "Fête du Travail"),
    fixed("05-08", "Victoire 1945"),
    { date: addDays(easter, 39), label: "Ascension" },
    { date: addDays(easter, 50), label: "Lundi de Pentecôte" },
    fixed("07-14", "Fête nationale"),
    fixed("08-15", "Assomption"),
    fixed("11-01", "Toussaint"),
    fixed("11-11", "Armistice 1918"),
    fixed("12-25", "Noël"),
  ].sort((x, y) => x.date.localeCompare(y.date));
}
