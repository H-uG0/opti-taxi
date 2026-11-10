/**
 * Links between the planning and the other screens of a day: a trip opened
 * on the planning (from Courses, Arrivées partagées), and back to its line in
 * Courses or to its patient's record. Pure.
 */
import type { TripDirection } from "@prisma/client";

/** « /planning?date=2026-11-10&trip=… »: the planning of the date, the trip selected (its row and the map framed on it). */
export function planningTripHref(date: string, tripId: string): string {
  return `/planning?${new URLSearchParams({ date, trip: tripId }).toString()}`;
}

/** Courses of the date filtered on the patient (and the leg when given), the same filters as its search form. */
export function coursesTripHref(date: string, patientName: string, direction: TripDirection | null = null): string {
  const params = new URLSearchParams({ date });
  if (direction) params.set("sens", direction);
  params.set("q", patientName.slice(0, 80));
  return `/courses?${params.toString()}`;
}

export function patientHref(patientId: string): string {
  return `/patients/${encodeURIComponent(patientId)}`;
}

/** « tel: » link of a phone number as typed (spaces and dots dropped). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[\s.]+/g, "")}`;
}
