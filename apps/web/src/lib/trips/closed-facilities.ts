/**
 * What the banner « Jour férié : N courses vers des établissements fermés »
 * shows, from the loaded groups (closed-facilities-load.ts). Pure (unit-tested).
 */
import { closedFacilitiesTitle, closedReasonText, type ClosedFacilityGroup, type Holiday } from "@/lib/domain/facility-calendar";

export type ClosedFacilitiesNoteProps = {
  title: string;
  lines: { facilityId: string; name: string; reason: string; count: number }[];
};

export function closedFacilitiesNoteProps(closed: { holiday: Holiday | null; groups: ClosedFacilityGroup[] }): ClosedFacilitiesNoteProps {
  const total = closed.groups.reduce((sum, g) => sum + g.tripIds.length, 0);
  return {
    title: closedFacilitiesTitle(closed.holiday, total),
    lines: closed.groups.map((g) => ({ facilityId: g.facilityId, name: g.name, reason: closedReasonText(g.reason), count: g.tripIds.length })),
  };
}
