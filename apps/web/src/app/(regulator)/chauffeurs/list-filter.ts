/**
 * Filters of the Chauffeurs list (all the staff), kept in the URL
 * (FilterBar): search on the name, the e-mail and the phone digits; depot,
 * qualification, alerts, tomorrow's situation and status. Pure module.
 */
import type { Qualification } from "@prisma/client";
import { idParam, matchesWords, phoneDigits, pickParam, readParam, type SearchParams } from "@/lib/list-filters";
import type { PersonDay } from "@/lib/staff/day-status";
import { QUALIFICATIONS } from "./schema";

export const STATUS_FILTERS = { actifs: "Actifs", inactifs: "Désactivés", tous: "Tous" } as const;
export type StatusFilter = keyof typeof STATUS_FILTERS;

/** « Sans dépôt » in the depot list. */
export const NO_DEPOT = "aucun";

export const ALERT_FILTERS = {
  toutes: "Toutes les alertes",
  pause: "Pause à régler",
  plusieurs: "Plusieurs véhicules par défaut",
  "sans-compte": "Sans compte d'accès actif",
} as const;
export type AlertFilter = keyof typeof ALERT_FILTERS;

export const TOMORROW_FILTERS = {
  absent: "Absents (congé, garde, formation…)",
  "en-poste": "Sur un véhicule",
  libre: "Disponibles sans véhicule",
  repos: "Ne travaillent pas ce jour",
} as const;
export type TomorrowFilter = keyof typeof TOMORROW_FILTERS;

export type DriverListFilter = {
  q: string;
  /** A depot id, NO_DEPOT, or null. */
  depot: string | null;
  qualification: Qualification | null;
  alert: AlertFilter | null;
  tomorrow: TomorrowFilter | null;
  status: StatusFilter;
};

export function parseDriverFilter(params: SearchParams): DriverListFilter {
  const status = pickParam(params, "statut", ["inactifs", "tous"] as const);
  return {
    q: readParam(params, "q"),
    depot: idParam(params, "depot"),
    qualification: pickParam(params, "qualification", QUALIFICATIONS),
    alert: pickParam(params, "alerte", Object.keys(ALERT_FILTERS) as AlertFilter[]),
    tomorrow: pickParam(params, "demain", Object.keys(TOMORROW_FILTERS) as TomorrowFilter[]),
    // « Afficher les désactivés » of the old list (?inactifs=1) showed everyone.
    status: status ?? (readParam(params, "inactifs") === "1" ? "tous" : "actifs"),
  };
}

export function isFiltered(filter: DriverListFilter): boolean {
  return (
    filter.q !== "" ||
    filter.depot !== null ||
    filter.qualification !== null ||
    filter.alert !== null ||
    filter.tomorrow !== null ||
    filter.status !== "actifs"
  );
}

export type FilterableDriver = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  depotId: string | null;
  qualifications: readonly Qualification[];
  active: boolean;
  /** Over 6 hours without a legal break (« Pause à régler »). */
  breakToFix: boolean;
  /** In the default crew of more than one active vehicle. */
  multiSeat: boolean;
  /** An active account to sign in to the driver app. */
  hasActiveAccount: boolean;
  tomorrow: PersonDay | null;
};

export function matchesDriverFilter(driver: FilterableDriver, filter: DriverListFilter): boolean {
  if (filter.status === "actifs" && !driver.active) return false;
  if (filter.status === "inactifs" && driver.active) return false;
  if (filter.depot === NO_DEPOT ? driver.depotId !== null : filter.depot !== null && driver.depotId !== filter.depot) return false;
  if (filter.qualification !== null && !driver.qualifications.includes(filter.qualification)) return false;
  if (filter.alert !== null && !hasAlert(driver, filter.alert)) return false;
  if (filter.tomorrow !== null && !isTomorrow(driver.tomorrow, filter.tomorrow)) return false;
  if (filter.q === "") return true;
  // A phone number typed with spaces, dots or +33 is found by its digits.
  const digits = phoneDigits(filter.q);
  if (digits.length >= 4 && /^[\d\s.+()-]+$/.test(filter.q)) return driver.phone !== null && phoneDigits(driver.phone).includes(digits);
  return matchesWords(filter.q, [driver.lastName, driver.firstName, driver.email]);
}

function hasAlert(driver: FilterableDriver, alert: AlertFilter): boolean {
  switch (alert) {
    case "pause":
      return driver.breakToFix;
    case "plusieurs":
      return driver.multiSeat;
    case "sans-compte":
      return !driver.hasActiveAccount;
    case "toutes":
      return driver.breakToFix || driver.multiSeat || !driver.hasActiveAccount;
  }
}

function isTomorrow(day: PersonDay | null, wanted: TomorrowFilter): boolean {
  if (!day) return false;
  switch (wanted) {
    case "absent":
      return day.kind === "absent";
    case "en-poste":
      return day.kind === "vehicle";
    case "libre":
      return day.kind === "free";
    case "repos":
      return day.kind === "rest";
  }
}
