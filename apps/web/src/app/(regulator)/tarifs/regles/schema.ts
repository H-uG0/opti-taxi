/**
 * Forms of « Règles de facturation » (/tarifs/regles): certification periods,
 * head office and readings of the conventions, public holidays, tariff areas.
 * Pure module, unit-tested.
 */
import { z } from "zod";
import type { TariffArea } from "@prisma/client";
import { parseCommuneList } from "@/lib/domain/tariff-areas";
import { dateField, optionalDateField, optionalText, requiredText, type FormValues } from "@/lib/forms";
import { fromIsoDate, toIsoDate } from "@/lib/time";
import { departmentField, isDepartmentCode, normalizeDepartment } from "../../vehicules/_lib/departments";
import { VERIFICATIONS } from "../schema";

const AFTER_START = "La fin doit être postérieure ou égale au début.";

export const certificationSchema = z
  .object({ validFrom: dateField(), validTo: optionalDateField(), note: optionalText(200) })
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, { path: ["validTo"], message: AFTER_START })
  .transform((v) => ({
    validFrom: fromIsoDate(v.validFrom),
    validTo: v.validTo === null ? null : fromIsoDate(v.validTo),
    note: v.note,
  }));

const optionalDepartment = z.preprocess(
  (raw) => (typeof raw === "string" ? normalizeDepartment(raw) : raw),
  z
    .string()
    .optional()
    .refine((v) => !v || isDepartmentCode(v), "Numéro de département de 2 ou 3 caractères (ex. 13, 04).")
    .transform((v) => (v ? v : null)),
);

export const billingSettingsSchema = z
  .object({
    hqDepartment: optionalDepartment,
    hqCity: optionalText(80),
    emptyLegRule: z.enum(["NONE", "DEPOT"], { error: "Choisissez une règle." }),
    surchargeOrder: z.enum(["MULTIPLICATIVE", "ADDITIVE"], { error: "Choisissez une règle." }),
    sharedPatientCount: z.enum(["DISTINCT", "MAX_ON_BOARD"], { error: "Choisissez une règle." }),
  })
  .refine((v) => (v.hqCity === null) === (v.hqDepartment === null), {
    path: ["hqCity"],
    message: "Renseignez le département et la commune du siège, ou aucun des deux.",
  });

export const holidaySchema = z.object({ date: dateField(), label: requiredText(80) }).transform((v) => ({
  date: fromIsoDate(v.date),
  label: v.label,
}));

export const areaSchema = z
  .object({
    kind: z.enum(["BIG_CITY", "AGGLOMERATION"], { error: "Choisissez un type de zone." }),
    name: requiredText(80),
    department: departmentField({ allowAllZones: true }),
    communes: z.string().max(4000).optional(),
    rule: z.enum(["ANY_END", "BOTH_INSIDE", "TO_HUB"], { error: "Choisissez une règle." }),
    hubCommune: optionalText(80),
    validFrom: optionalDateField(),
    validTo: optionalDateField(),
    verification: z.enum(VERIFICATIONS, { error: "Choisissez un niveau de vérification." }),
    sourceUrl: optionalText(500).refine((v) => v === null || /^https?:\/\/\S+$/.test(v), "Adresse web attendue (https://…)."),
    notes: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (parseCommuneList(v.communes ?? "").length === 0) {
      ctx.addIssue({ code: "custom", path: ["communes"], message: "Au moins une commune." });
    }
    if (v.rule === "TO_HUB" && !v.hubCommune) {
      ctx.addIssue({ code: "custom", path: ["hubCommune"], message: "La règle «\u202fvers la commune centre\u202f» demande cette commune." });
    }
    if (v.validFrom !== null && v.validTo !== null && v.validTo < v.validFrom) {
      ctx.addIssue({ code: "custom", path: ["validTo"], message: AFTER_START });
    }
  })
  .transform((v) => ({
    kind: v.kind,
    name: v.name,
    department: v.department,
    communes: parseCommuneList(v.communes ?? ""),
    rule: v.rule,
    hubCommune: v.rule === "TO_HUB" ? v.hubCommune : null,
    validFrom: v.validFrom === null ? null : fromIsoDate(v.validFrom),
    validTo: v.validTo === null ? null : fromIsoDate(v.validTo),
    verification: v.verification,
    sourceUrl: v.sourceUrl,
    notes: v.notes,
  }));

export const AREA_AUDIT_FIELDS = ["kind", "name", "department", "communes", "rule", "hubCommune", "validFrom", "validTo", "verification"] as const;

export function areaFormValues(area?: Omit<TariffArea, "id" | "createdAt" | "updatedAt">): FormValues {
  if (!area) {
    return {
      kind: "BIG_CITY",
      name: "",
      department: "",
      communes: "",
      rule: "ANY_END",
      hubCommune: "",
      validFrom: "",
      validTo: "",
      verification: "UNVERIFIED",
      sourceUrl: "",
      notes: "",
    };
  }
  return {
    kind: area.kind,
    name: area.name,
    department: area.department,
    communes: area.communes.join("\n"),
    rule: area.rule,
    hubCommune: area.hubCommune ?? "",
    validFrom: area.validFrom ? toIsoDate(area.validFrom) : "",
    validTo: area.validTo ? toIsoDate(area.validTo) : "",
    verification: area.verification,
    sourceUrl: area.sourceUrl ?? "",
    notes: area.notes ?? "",
  };
}
