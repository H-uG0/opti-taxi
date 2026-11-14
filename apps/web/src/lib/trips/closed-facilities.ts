/**
 * What the banner « Jour férié : N courses vers des établissements fermés »
 * shows, from the loaded groups (closed-facilities-load.ts). Pure (unit-tested).
 */
import { closedFacilitiesTitle, closedReasonText, type ClosedFacilityGroup, type Holiday } from "@/lib/domain/facility-calendar";

export type ClosedFacilityLine = {
  facilityId: string;
  name: string;
  reason: string;
  /** Closed because it does not work public holidays (not a dated closure): « Ouvert les jours fériés » helps. */
  holiday: boolean;
  count: number;
  /** The trips shown: the cancellation cancels these only (never one the page did not show). */
  tripIds: string[];
};

export type ClosedFacilitiesNoteProps = { title: string; lines: ClosedFacilityLine[] };

export function closedFacilitiesNoteProps(closed: { holiday: Holiday | null; groups: ClosedFacilityGroup[] }): ClosedFacilitiesNoteProps {
  const total = closed.groups.reduce((sum, g) => sum + g.tripIds.length, 0);
  return {
    title: closedFacilitiesTitle(closed.holiday, total),
    lines: closed.groups.map((g) => ({
      facilityId: g.facilityId,
      name: g.name,
      reason: closedReasonText(g.reason),
      holiday: g.reason.kind === "holiday",
      count: g.tripIds.length,
      tripIds: g.tripIds,
    })),
  };
}
