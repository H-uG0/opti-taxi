/**
 * « Nouvelle course » carried through « Nouvelle prescription » and back: the
 * choices already made in the form that are no health data (direction, times,
 * the facility id — never a note or an address), and where the form was
 * opened from (« Annuler » and the back link lead there). In the URL, checked
 * on write and on read. Pure.
 */
import type { NewTripDirection } from "../trip-form";

export type TripDraft = {
  direction?: NewTripDirection;
  /** Appointment (or end of session of a return), "HH:MM". */
  time?: string;
  /** End of session of « Aller et retour », "HH:MM". */
  returnTime?: string;
  facilityId?: string;
  /** Opened from « Courses » (a patient chosen in the form): back there, not to the record. */
  fromCourses?: boolean;
};

type Params = Record<string, string | string[] | undefined>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIRECTIONS: readonly string[] = ["OUTBOUND", "RETURN", "BOTH"] satisfies NewTripDirection[];

/** Query parameter of each choice, and the check of its value. */
const FIELDS = {
  direction: { param: "sens", valid: (v: string) => DIRECTIONS.includes(v) },
  time: { param: "heure", valid: (v: string) => TIME.test(v) },
  returnTime: { param: "fin", valid: (v: string) => TIME.test(v) },
  facilityId: { param: "etab", valid: (v: string) => ID.test(v) },
} as const;

const FROM_COURSES = { param: "retour", value: "courses" } as const;

function first(params: Params, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/** The draft read back from a page's address: what does not pass its check is dropped. */
export function readTripDraft(params: Params): TripDraft {
  const draft: TripDraft = {};
  for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, (typeof FIELDS)[keyof typeof FIELDS]][]) {
    const value = first(params, field.param);
    if (value !== undefined && field.valid(value)) Object.assign(draft, { [key]: value });
  }
  if (first(params, FROM_COURSES.param) === FROM_COURSES.value) draft.fromCourses = true;
  return draft;
}

/** Query entries of `draft` (valid values only, so a draft built anywhere is checked again). */
export function tripDraftEntries(draft: TripDraft): [string, string][] {
  const entries: [string, string][] = [];
  for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, (typeof FIELDS)[keyof typeof FIELDS]][]) {
    const value = draft[key];
    if (typeof value === "string" && field.valid(value)) entries.push([field.param, value]);
  }
  if (draft.fromCourses === true) entries.push([FROM_COURSES.param, FROM_COURSES.value]);
  return entries;
}

/** « /courses/nouvelle?patient=…&date=…[&sens=…&heure=…&fin=…&etab=…][&retour=courses][&pmt=1] »: back to the new trip. */
export function newTripHref(patientId: string, date: string, draft: TripDraft, prescriptionSaved = false): string {
  const params = new URLSearchParams([["patient", patientId], ["date", date], ...tripDraftEntries(draft)]);
  if (prescriptionSaved) params.set("pmt", "1");
  return `/courses/nouvelle?${params.toString()}`;
}

/** « /patients/…/prescriptions/nouvelle?course=<date>&… »: a new PMT, then back to the new trip as it was. */
export function newPrescriptionHref(patientId: string, date: string, draft: TripDraft): string {
  const params = new URLSearchParams([["course", date], ...tripDraftEntries(draft)]);
  return `/patients/${patientId}/prescriptions/nouvelle?${params.toString()}`;
}
