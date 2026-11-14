/** Facility types offered by the form (mirror prisma/schema.prisma). */
import type { FacilityType } from "@prisma/client";

export const FACILITY_TYPES = [
  "HOSPITAL",
  "DIALYSIS",
  "RADIOTHERAPY",
  "CHEMOTHERAPY",
  "CLINIC",
  "OTHER",
] as const satisfies readonly FacilityType[];

/** A new facility works on public holidays by default when it is a dialysis centre. */
export function holidayDefault(type: string): boolean {
  return type === "DIALYSIS";
}
