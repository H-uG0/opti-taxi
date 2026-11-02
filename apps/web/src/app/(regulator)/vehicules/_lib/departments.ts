/**
 * French department codes used by vehicles (rattachement) and tariff grids.
 * Names are display labels only: tariffs themselves always live in the database.
 */
import { z } from "zod";
import { REQUIRED } from "@/lib/forms";

/** Catch-all department of a tariff grid ("toutes zones"). */
export const ALL_ZONES = "*";

/** Departments of the Marseille – Grenoble axis and their neighbours (suggestions in forms). */
export const DEPARTMENT_NAMES: Record<string, string> = {
  "04": "Alpes-de-Haute-Provence",
  "05": "Hautes-Alpes",
  "06": "Alpes-Maritimes",
  "13": "Bouches-du-Rhône",
  "26": "Drôme",
  "38": "Isère",
  "73": "Savoie",
  "83": "Var",
  "84": "Vaucluse",
};

/** "4" -> "04", " 2a " -> "2A". */
export function normalizeDepartment(raw: string): string {
  const value = raw.trim().toUpperCase();
  return /^\d$/.test(value) ? `0${value}` : value;
}

/** 2 or 3 characters: "13", "04", "2A", "2B", "971". */
export function isDepartmentCode(value: string): boolean {
  return /^(?:\d{2,3}|2[AB])$/.test(value);
}

export function departmentLabel(code: string): string {
  if (code === ALL_ZONES) return "Toutes zones";
  const name = DEPARTMENT_NAMES[code];
  return name ? `${code} · ${name}` : code;
}

/** Department input; with `allowAllZones`, "*" (toutes zones) is accepted too. */
export function departmentField({ allowAllZones = false }: { allowAllZones?: boolean } = {}) {
  return z.preprocess(
    (raw) => (typeof raw === "string" ? normalizeDepartment(raw) : raw),
    z
      .string({ error: REQUIRED })
      .min(1, REQUIRED)
      .refine(
        (value) => isDepartmentCode(value) || (allowAllZones && value === ALL_ZONES),
        allowAllZones
          ? "Numéro de département (ex. 13, 04, 2A) ou * pour toutes les zones."
          : "Numéro de département de 2 ou 3 caractères (ex. 13, 04, 05, 38, 2A).",
      ),
  );
}
