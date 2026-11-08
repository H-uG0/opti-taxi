/**
 * Absences (leave, sickness, training, on-call duty…) and crew
 * incompatibilities of a driver: form validation. Pure module (unit-tested).
 */
import { z } from "zod";
import type { AbsenceKind } from "@prisma/client";
import { dateField, idSchema, optionalText } from "@/lib/forms";
import { addDays } from "@/lib/time";

export const ABSENCE_KINDS = ["LEAVE", "SICK", "TRAINING", "ON_CALL", "OTHER"] as const satisfies readonly AbsenceKind[];

/** Longest absence entered at once (a longer one is entered in several parts). */
export const MAX_ABSENCE_DAYS = 366;

export const absenceSchema = z
  .object({
    kind: z.enum(ABSENCE_KINDS, { error: "Choisissez un motif." }),
    startDate: dateField(),
    endDate: dateField(),
    note: optionalText(200),
  })
  .superRefine((v, ctx) => {
    if (v.endDate < v.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "La fin doit être le même jour que le début, ou après." });
    } else if (v.endDate > addDays(v.startDate, MAX_ABSENCE_DAYS - 1)) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: `Au plus ${MAX_ABSENCE_DAYS} jours d'affilée.` });
    }
  });

export const incompatibilitySchema = z.object({
  otherId: idSchema,
  note: optionalText(200),
});

/** The stored order of a pair (driverAId < driverBId): one row per pair, whoever enters it. */
export function orderedPair(a: string, b: string): { driverAId: string; driverBId: string } {
  return a < b ? { driverAId: a, driverBId: b } : { driverAId: b, driverBId: a };
}
