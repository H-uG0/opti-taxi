/**
 * A dated closure of a facility (« Fermetures » on its record): first and last
 * day (included) and a note. Pure module (unit-tested).
 */
import { z } from "zod";
import { dateField, optionalText } from "@/lib/forms";
import { addDays } from "@/lib/time";

/** Longest closure entered at once. */
export const MAX_CLOSURE_DAYS = 366;

export const closureSchema = z
  .object({
    startDate: dateField(),
    endDate: dateField(),
    note: optionalText(200),
  })
  .superRefine((v, ctx) => {
    if (v.endDate < v.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "La fin doit être le même jour que le début, ou après." });
    } else if (v.endDate > addDays(v.startDate, MAX_CLOSURE_DAYS - 1)) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: `Au plus ${MAX_CLOSURE_DAYS} jours d'affilée.` });
    }
  });
