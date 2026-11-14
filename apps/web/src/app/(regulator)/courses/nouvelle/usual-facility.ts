/**
 * What « Nouvelle course » proposes once a patient is chosen: the facility
 * they usually go to and the length of their session there (to suggest the
 * end of session of « Aller et retour »). Pure.
 */

export type UsualRecurrence = { facilityId: string; weekdays: readonly number[]; sessionMinutes: number; createdAt: Date };
export type RecentTrip = { facilityId: string | null; serviceDate: string };

/**
 * The care facility of the patient: the one of their active recurrence with
 * the most days a week (the latest created on a tie), otherwise the one of
 * their latest trip. Only an active facility is proposed; null when none.
 */
export function usualFacility(
  recurrences: readonly UsualRecurrence[],
  recentTrips: readonly RecentTrip[],
  activeFacilityIds: ReadonlySet<string>,
): { facilityId: string; sessionMinutes: number | null } | null {
  const regular = recurrences
    .filter((r) => activeFacilityIds.has(r.facilityId))
    .sort((a, b) => b.weekdays.length - a.weekdays.length || b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (regular) return { facilityId: regular.facilityId, sessionMinutes: regular.sessionMinutes };
  const latest = recentTrips
    .filter((t): t is RecentTrip & { facilityId: string } => t.facilityId !== null && activeFacilityIds.has(t.facilityId))
    .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate))[0];
  return latest ? { facilityId: latest.facilityId, sessionMinutes: null } : null;
}

/** The end of session suggested for « Aller et retour »: appointment + usual session, before midnight; null otherwise. */
export function suggestedReturnMinute(appointmentMinute: number | null, sessionMinutes: number | null): number | null {
  if (appointmentMinute === null || sessionMinutes === null || sessionMinutes <= 0) return null;
  const end = appointmentMinute + sessionMinutes;
  return end < 1440 ? end : null;
}
