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
