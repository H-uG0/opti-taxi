"use server";

import { auditRead } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { MOBILITY_LABELS } from "@/lib/labels";
import { formatPersonName } from "@/lib/names";
import { todayIso } from "@/lib/time";
import { searchTerms } from "../../patients/_lib/list-filter";
import type { PatientOption } from "./new-trip-form";
import { loadTripPatient } from "./trip-patient";

/** At most this many patients per answer: a name, a phone number or a town narrows it down. */
const SEARCH_LIMIT = 20;

export type PatientSearchResult = {
  /** "short": too little typed to search (nothing read). */
  status: "ok" | "short";
  options: { value: string; label: string; hint: string }[];
  /** More patients match than shown. */
  more: boolean;
};

/**
 * The patient choice of « Nouvelle course »: active patients whose name,
 * town, postal code or phone match what is typed (Patient.searchText, without
 * accents), searched on the server so the page never ships every patient to
 * the browser. Traced as a read of the list (patient_list.view, with the
 * number of patients shown; never the text typed).
 */
export async function searchTripPatients(query: string): Promise<PatientSearchResult> {
  const user = await requireUser("REGULATOR");
  const text = typeof query === "string" ? query.slice(0, 80) : "";
  const terms = searchTerms(text);
  const digitsOnly = /^\d+$/.test(terms[0] ?? "");
  if (terms.length === 0 || (digitsOnly ? terms[0]!.length < 2 : terms.join("").length < 2)) {
    return { status: "short", options: [], more: false };
  }
  const rows = await db.patient.findMany({
    where: { active: true, AND: terms.map((term) => ({ searchText: { contains: term } })) },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    take: SEARCH_LIMIT + 1,
    select: { id: true, firstName: true, lastName: true, city: true, postalCode: true, phone: true, mobility: true },
  });
  const shown = rows.slice(0, SEARCH_LIMIT);
  if (shown.length > 0) {
    await auditRead(user, { action: "patient_list.view", entity: "Patient", entityId: null, details: { source: "trip_search", shown: shown.length } });
  }
  return {
    status: "ok",
    more: rows.length > SEARCH_LIMIT,
    options: shown.map((p) => ({
      value: p.id,
      label: formatPersonName(p),
      hint: [`${p.postalCode} ${p.city}`, p.phone, MOBILITY_LABELS[p.mobility]].filter(Boolean).join(" · "),
    })),
  };
}

/** The chosen patient's prescriptions and usual facility (traced patient.view); null for an unknown or deactivated patient. */
export async function loadPatientForTrip(patientId: string): Promise<PatientOption | null> {
  const user = await requireUser("REGULATOR");
  if (typeof patientId !== "string" || patientId.length === 0 || patientId.length > 64) return null;
  return loadTripPatient(user, patientId, todayIso());
}
