/**
 * Filters of the Patients list, kept in the URL (FilterBar): search without
 * accents on the name, city and postal code, or on the phone's digits
 * (Patient.searchText, kept by a database trigger); status, prescription to
 * renew (candidates in SQL, then the renewal rule: awaitingRenewal) or
 * missing, facility of an active recurrence, mobility; sort and page. Pure
 * module: the Prisma `where` and `orderBy` it builds are plain objects, unit-tested.
 */
import type { Mobility, Prisma } from "@prisma/client";
import type { SeriesPrescription } from "@/lib/domain/renewal";
import { idParam, normalizeSearch, phoneDigits, pickParam, readParam, type SearchParams } from "@/lib/list-filters";
import { addDays, fromIsoDate, toIsoDate } from "@/lib/time";
import { EXPIRY_WARNING_DAYS, findRenewal, needsRenewal, pickCurrentPrescription } from "./status";

export const PATIENT_PAGE_SIZE = 100;

export const STATUS_FILTERS = { actifs: "Actifs", inactifs: "Désactivés", tous: "Tous" } as const;
export type StatusFilter = keyof typeof STATUS_FILTERS;

export const PRESCRIPTION_FILTERS = {
  "a-renouveler": `Expire sous ${EXPIRY_WARNING_DAYS} jours, non renouvelée`,
  sans: "Sans prescription valide aujourd'hui",
} as const;
export type PrescriptionFilter = keyof typeof PRESCRIPTION_FILTERS;

export const MOBILITIES = ["SEATED", "WHEELCHAIR", "LYING"] as const satisfies readonly Mobility[];

export const SORTS = { nom: "Nom (A → Z)", "nom-desc": "Nom (Z → A)", ville: "Ville", recent: "Ajout le plus récent" } as const;
export type PatientSort = keyof typeof SORTS;

export type PatientListFilter = {
  q: string;
  status: StatusFilter;
  prescription: PrescriptionFilter | null;
  facility: string | null;
  mobility: Mobility | null;
  sort: PatientSort;
};

export function parsePatientFilter(params: SearchParams): PatientListFilter {
  return {
    q: readParam(params, "q"),
    status: pickParam(params, "statut", ["inactifs", "tous"] as const) ?? "actifs",
    prescription: pickParam(params, "pmt", Object.keys(PRESCRIPTION_FILTERS) as PrescriptionFilter[]),
    facility: idParam(params, "etablissement"),
    mobility: pickParam(params, "mobilite", MOBILITIES),
    sort: pickParam(params, "tri", ["nom-desc", "ville", "recent"] as const) ?? "nom",
  };
}

/** Anything but the default list (active patients, by name). The sort is not a filter. */
export function isFiltered(filter: PatientListFilter): boolean {
  return filter.q !== "" || filter.status !== "actifs" || filter.prescription !== null || filter.facility !== null || filter.mobility !== null;
}

/**
 * What the search looks for in Patient.searchText: every word, lowercase
 * without accents (« Hélène » finds « HELENE »); a number typed with spaces,
 * dots or +33 is one term, its national digits (« +33 6 12 » → « 0612 »).
 */
export function searchTerms(q: string): string[] {
  if (/\d/.test(q) && /^[\d\s.+()-]+$/.test(q)) {
    const digits = phoneDigits(q);
    return digits ? [digits] : [];
  }
  return normalizeSearch(q).split(" ").filter(Boolean).slice(0, 5);
}

/**
 * The Prisma filter of the list on `todayIso`. For « à renouveler » it only
 * picks the candidates (a prescription valid today ending within the warning
 * period): the page keeps those `awaitingRenewal` says, the same rule as the
 * row's badge (a renewal has the same mode and the same series of care).
 */
export function patientWhere(filter: PatientListFilter, todayIso: string): Prisma.PatientWhereInput {
  const today = fromIsoDate(todayIso);
  const limit = fromIsoDate(addDays(todayIso, EXPIRY_WARNING_DAYS));
  const and: Prisma.PatientWhereInput[] = searchTerms(filter.q).map((term) => ({ searchText: { contains: term } }));
  if (filter.prescription === "a-renouveler") {
    and.push({ prescriptions: { some: { validFrom: { lte: today }, validTo: { gte: today, lte: limit } } } });
  } else if (filter.prescription === "sans") {
    and.push({ prescriptions: { none: { validFrom: { lte: today }, validTo: { gte: today } } } });
  }
  if (filter.facility) and.push({ recurrences: { some: { active: true, facilityId: filter.facility } } });
  return {
    ...(filter.status === "tous" ? {} : { active: filter.status === "actifs" }),
    ...(filter.mobility ? { mobility: filter.mobility } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
}

/**
 * « Expire sous 14 jours, non renouvelée »: the patient's current prescription
 * (the one the list shows) is valid today, ends within the warning period and
 * nothing renews it (lib/domain/renewal.ts: same mode, same series of care) —
 * exactly the rows with a red « Expire dans N j » badge.
 */
export function awaitingRenewal<T extends SeriesPrescription>(prescriptions: T[], todayIso: string): boolean {
  const current = pickCurrentPrescription(prescriptions, todayIso);
  if (!current) return false;
  const dates = { validFrom: toIsoDate(current.validFrom), validTo: toIsoDate(current.validTo) };
  if (dates.validFrom > todayIso || dates.validTo < todayIso || !needsRenewal(dates, todayIso)) return false;
  return findRenewal(current, prescriptions) === null;
}

/** Sort of the list; the id last, so that a page always holds the same patients. */
export function patientOrderBy(sort: PatientSort): Prisma.PatientOrderByWithRelationInput[] {
  switch (sort) {
    case "nom-desc":
      return [{ lastName: "desc" }, { firstName: "desc" }, { id: "asc" }];
    case "ville":
      return [{ city: "asc" }, { lastName: "asc" }, { firstName: "asc" }, { id: "asc" }];
    case "recent":
      return [{ createdAt: "desc" }, { id: "asc" }];
    case "nom":
      return [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }];
  }
}

/** The filters as URL parameters (defaults left out), for the page links. */
export function patientParams(filter: PatientListFilter): Record<string, string | null> {
  return {
    q: filter.q || null,
    statut: filter.status === "actifs" ? null : filter.status,
    pmt: filter.prescription,
    etablissement: filter.facility,
    mobilite: filter.mobility,
    tri: filter.sort === "nom" ? null : filter.sort,
  };
}
