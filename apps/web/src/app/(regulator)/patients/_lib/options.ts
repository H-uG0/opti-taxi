/** Choices offered by the patient, prescription and recurrence forms (mirror prisma/schema.prisma). */
import type { Mobility, PrescribedMode, RecurrenceLegs, SharingScope } from "@prisma/client";

export const MOBILITIES = ["SEATED", "WHEELCHAIR", "LYING"] as const satisfies readonly Mobility[];
export const PRESCRIBED_MODES = ["TAP", "AMBULANCE"] as const satisfies readonly PrescribedMode[];
export const SHARING_SCOPES = ["NONE", "OUTBOUND", "RETURN", "BOTH"] as const satisfies readonly SharingScope[];
export const RECURRENCE_LEGS = ["OUTBOUND", "RETURN", "BOTH"] as const satisfies readonly RecurrenceLegs[];
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Longest session the recurrence form accepts (12 h). */
export const MAX_SESSION_MINUTES = 720;
