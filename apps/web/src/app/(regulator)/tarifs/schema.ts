/**
 * Tariff grid form. Rates are typed as percentages in the UI and stored as
 * fractions (23 % -> 0.23), like every rate in the app; times as HH:MM and
 * stored as minutes; the short-trip bands as one « km : € » per line.
 * Pure module, unit-tested.
 */
import { z } from "zod";
import type { TariffGrid, TariffVerification, VehicleType } from "@prisma/client";
import type { BadgeTone } from "@/components/ui/badge";
import { readSharedDiscounts, readShortTripBands } from "@/lib/domain/tariffs";
import type { FareGrid, ShortTripBand } from "@/lib/domain/fare";
import { formatMinute, fromIsoDate, toIsoDate } from "@/lib/time";
import { departmentField } from "../vehicules/_lib/departments";
import {
  dateField,
  formatDecimalInput,
  formatNumber,
  numberField,
  optionalDateField,
  optionalNumberField,
  optionalText,
  parseDecimal,
  timeField,
  type FormValues,
} from "@/lib/forms";

export const VEHICLE_TYPES = ["TAXI", "VSL", "AMBULANCE"] as const satisfies readonly VehicleType[];
export const VERIFICATIONS = ["OFFICIAL", "SECONDARY", "UNVERIFIED"] as const satisfies readonly TariffVerification[];

export const VERIFICATION_LABELS: Record<TariffVerification, string> = {
  OFFICIAL: "Officiel",
  SECONDARY: "Source secondaire",
  UNVERIFIED: "Non vérifié",
};

export const VERIFICATION_TONES: Record<TariffVerification, BadgeTone> = {
  OFFICIAL: "success",
  SECONDARY: "info",
  UNVERIFIED: "warning",
};

/** Certification select: "" = sans objet (taxi, or a grid for any company). */
export const CERTIFICATION_OPTIONS = [
  { value: "", label: "Toute entreprise (sans objet)" },
  { value: "true", label: "Entreprise certifiée (grille majorée)" },
  { value: "false", label: "Entreprise non certifiée (grille socle)" },
] as const;

export function certificationLabel(certified: boolean | null): string {
  return certified === null ? "Toute entreprise" : certified ? "Certifiée" : "Non certifiée";
}

/** 23 -> 0.23 (rounded to 1/100 of a percent to avoid float noise). */
export function percentToFraction(percent: number): number {
  return Math.round(percent * 100) / 10000;
}

/** 0.23 -> 23. */
export function fractionToPercent(fraction: number): number {
  return Math.round(fraction * 10000) / 100;
}

/** "7 : 8,54" per line -> bands sorted by distance; a line that is not « km : € » is an error (null). */
export function parseShortTripBands(text: string): ShortTripBand[] | null {
  const bands: ShortTripBand[] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(?:≤|<=)?\s*([\d\s.,]+?)\s*(?:km)?\s*[:=;→>-]+\s*([\d\s.,]+?)\s*(?:€)?$/i.exec(line);
    const upToKm = match ? parseDecimal(match[1]) : undefined;
    const amount = match ? parseDecimal(match[2]) : undefined;
    if (upToKm === undefined || amount === undefined || !Number.isFinite(upToKm) || !Number.isFinite(amount)) return null;
    bands.push({ upToKm, amount });
  }
  return bands.sort((a, b) => a.upToKm - b.upToKm);
}

export function formatShortTripBands(bands: readonly ShortTripBand[]): string {
  return bands.map((b) => `${formatNumber(b.upToKm)} : ${formatDecimalInput(b.amount)}`).join("\n");
}

/** "10 ; 10" -> [10, 10]; null for anything else than numbers. */
export function parseKmList(text: string): number[] | null {
  const parts = text.split(/[;\s]+/).map((part) => part.trim()).filter(Boolean);
  const values = parts.map((part) => parseDecimal(part));
  return values.every((v): v is number => v !== undefined && Number.isFinite(v) && v >= 0) ? values : null;
}

const percent = (max = 100) => numberField({ min: 0, max, unit: "%" });
const optionalPercent = () => optionalNumberField({ min: 0, max: 100, unit: "%" });

const tariffFields = z.object({
  vehicleType: z.enum(VEHICLE_TYPES, { error: "Choisissez un type de véhicule." }),
  department: departmentField({ allowAllZones: true }),
  certified: z.enum(["", "true", "false"], { error: "Choisissez une certification." }),
  zone: z
    .string()
    .trim()
    .max(1, "Une lettre (A, B, C ou D).")
    .regex(/^[A-Da-d]?$/, "Une lettre (A, B, C ou D).")
    .optional()
    .transform((value) => (value ? value.toUpperCase() : null)),
  label: optionalText(80),
  baseFare: numberField({ min: 0, max: 1000, unit: "€" }),
  aggloFare: optionalNumberField({ min: 0, max: 1000, unit: "€" }),
  bigCityFare: optionalNumberField({ min: 0, max: 1000, unit: "€" }),
  includedKm: optionalNumberField({ min: 0, max: 1000, unit: "km" }),
  pricePerKm: numberField({ min: 0, max: 50, unit: "€/km" }),
  shortTripBands: z.string().max(2000).optional(),
  nightRate: percent(500),
  weekendRate: percent(500),
  nightStart: timeField(),
  nightEnd: timeField(),
  saturdayFrom: timeField(),
  surchargeShortTrip: z.string().optional(),
  emptyLegRateShort: optionalNumberField({ min: 0, max: 500, unit: "%" }),
  emptyLegRateLong: optionalNumberField({ min: 0, max: 500, unit: "%" }),
  emptyLegThresholdKm: optionalNumberField({ min: 0, max: 1000, unit: "km" }),
  discount2: optionalPercent(),
  discount3: optionalPercent(),
  discount4: optionalPercent(),
  maxSharedPatients: numberField({ min: 1, max: 8, integer: true }),
  aloneDiscount: optionalPercent(),
  aloneThresholdKm: optionalNumberField({ min: 0, max: 1000, unit: "km" }),
  billableDetourKm: z.string().max(200).optional(),
  tpmrFare: optionalNumberField({ min: 0, max: 1000, unit: "€" }),
  verification: z.enum(VERIFICATIONS, { error: "Choisissez un niveau de vérification." }),
  sourceUrl: optionalText(500).refine((v) => v === null || /^https?:\/\/\S+$/.test(v), "Adresse web attendue (https://…)."),
  validFrom: dateField(),
  validTo: optionalDateField(),
  notes: optionalText(500),
});

export const tariffSchema = tariffFields
  .superRefine((v, ctx) => {
    const discounts = [v.discount2, v.discount3, v.discount4];
    discounts.forEach((rate, i) => {
      const before = discounts.slice(0, i).filter((d): d is number => d !== undefined);
      if (rate !== undefined && before.some((d) => d > rate)) {
        ctx.addIssue({
          code: "custom",
          path: [`discount${i + 2}`],
          message: "Un abattement ne peut pas être inférieur à celui d'un nombre de patients plus petit.",
        });
      }
    });
    if (v.shortTripBands && parseShortTripBands(v.shortTripBands) === null) {
      ctx.addIssue({ code: "custom", path: ["shortTripBands"], message: "Une tranche par ligne : « km : montant », ex. « 7 : 8,54 »." });
    } else if (v.shortTripBands) {
      const bands = parseShortTripBands(v.shortTripBands)!;
      if (new Set(bands.map((b) => b.upToKm)).size !== bands.length) {
        ctx.addIssue({ code: "custom", path: ["shortTripBands"], message: "Deux tranches ont la même distance." });
      }
    }
    if (v.billableDetourKm && parseKmList(v.billableDetourKm) === null) {
      ctx.addIssue({ code: "custom", path: ["billableDetourKm"], message: "Des km séparés par « ; », ex. « 10 ; 10 »." });
    }
    if (v.validTo !== null && v.validTo < v.validFrom) {
      ctx.addIssue({ code: "custom", path: ["validTo"], message: "La fin de validité doit être postérieure ou égale au début." });
    }
  })
  .transform((v) => {
    const discounts = [v.discount2, v.discount3, v.discount4]
      .map((rate, i) => (rate === undefined ? null : { patients: i + 2, rate: percentToFraction(rate) }))
      .filter((d): d is { patients: number; rate: number } => d !== null);
    return {
      vehicleType: v.vehicleType,
      department: v.department,
      certified: v.certified === "" ? null : v.certified === "true",
      zone: v.zone,
      label: v.label,
      baseFare: v.baseFare,
      aggloFare: v.aggloFare ?? null,
      bigCityFare: v.bigCityFare ?? 0,
      includedKm: v.includedKm ?? 0,
      pricePerKm: v.pricePerKm,
      shortTripBands: v.shortTripBands ? (parseShortTripBands(v.shortTripBands) ?? []) : [],
      nightRate: percentToFraction(v.nightRate),
      weekendRate: percentToFraction(v.weekendRate),
      nightStartMinute: v.nightStart,
      nightEndMinute: v.nightEnd,
      saturdayFromMinute: v.saturdayFrom,
      surchargeShortTrip: v.surchargeShortTrip === "on",
      emptyLegRateShort: percentToFraction(v.emptyLegRateShort ?? 0),
      emptyLegRateLong: percentToFraction(v.emptyLegRateLong ?? 0),
      emptyLegThresholdKm: v.emptyLegThresholdKm ?? 50,
      sharedDiscounts: discounts,
      maxSharedPatients: v.maxSharedPatients,
      aloneDiscount: percentToFraction(v.aloneDiscount ?? 0),
      aloneThresholdKm: v.aloneThresholdKm ?? 30,
      billableDetourKm: v.billableDetourKm ? (parseKmList(v.billableDetourKm) ?? []) : [],
      tpmrFare: v.tpmrFare ?? 0,
      verification: v.verification,
      sourceUrl: v.sourceUrl,
      validFrom: fromIsoDate(v.validFrom),
      validTo: v.validTo === null ? null : fromIsoDate(v.validTo),
      notes: v.notes,
    };
  });

export type TariffInput = z.output<typeof tariffSchema>;

/** Fields traced with their old and new value (tariff.*): amounts, rates, dates and scope, not the free texts. */
export const TARIFF_AUDIT_FIELDS = [
  "vehicleType",
  "department",
  "certified",
  "baseFare",
  "aggloFare",
  "bigCityFare",
  "includedKm",
  "pricePerKm",
  "shortTripBands",
  "nightRate",
  "weekendRate",
  "nightStartMinute",
  "nightEndMinute",
  "saturdayFromMinute",
  "surchargeShortTrip",
  "emptyLegRateShort",
  "emptyLegRateLong",
  "emptyLegThresholdKm",
  "sharedDiscounts",
  "maxSharedPatients",
  "aloneDiscount",
  "aloneThresholdKm",
  "billableDetourKm",
  "tpmrFare",
  "verification",
  "validFrom",
  "validTo",
] as const satisfies readonly (keyof TariffInput)[];

type TariffRecord = Omit<TariffGrid, "id" | "createdAt" | "updatedAt">;

const pct = (fraction: number) => formatDecimalInput(fractionToPercent(fraction));

/**
 * Form values of a grid. `overrides` lets "Dupliquer" start a new version
 * from an existing grid (new start date, no end date).
 */
export function tariffFormValues(grid?: TariffRecord, overrides: Partial<Record<string, string>> = {}): FormValues {
  const discounts = grid ? readSharedDiscounts(grid.sharedDiscounts) : [];
  const discount = (patients: number) => {
    const found = discounts.find((d) => d.patients === patients);
    return found ? pct(found.rate) : "";
  };
  const base: FormValues = grid
    ? {
        vehicleType: grid.vehicleType,
        department: grid.department,
        certified: grid.certified === null ? "" : String(grid.certified),
        zone: grid.zone ?? "",
        label: grid.label ?? "",
        baseFare: formatDecimalInput(grid.baseFare),
        aggloFare: formatDecimalInput(grid.aggloFare),
        bigCityFare: grid.bigCityFare ? formatDecimalInput(grid.bigCityFare) : "",
        includedKm: formatDecimalInput(grid.includedKm),
        pricePerKm: formatDecimalInput(grid.pricePerKm),
        shortTripBands: formatShortTripBands(readShortTripBands(grid.shortTripBands)),
        nightRate: pct(grid.nightRate),
        weekendRate: pct(grid.weekendRate),
        nightStart: formatMinute(grid.nightStartMinute),
        nightEnd: formatMinute(grid.nightEndMinute),
        saturdayFrom: formatMinute(grid.saturdayFromMinute),
        surchargeShortTrip: grid.surchargeShortTrip ? "on" : "",
        emptyLegRateShort: grid.emptyLegRateShort ? pct(grid.emptyLegRateShort) : "",
        emptyLegRateLong: grid.emptyLegRateLong ? pct(grid.emptyLegRateLong) : "",
        emptyLegThresholdKm: formatDecimalInput(grid.emptyLegThresholdKm),
        discount2: discount(2),
        discount3: discount(3),
        discount4: discount(4),
        maxSharedPatients: String(grid.maxSharedPatients),
        aloneDiscount: grid.aloneDiscount ? pct(grid.aloneDiscount) : "",
        aloneThresholdKm: formatDecimalInput(grid.aloneThresholdKm),
        billableDetourKm: grid.billableDetourKm.map(formatDecimalInput).join(" ; "),
        tpmrFare: grid.tpmrFare ? formatDecimalInput(grid.tpmrFare) : "",
        verification: grid.verification,
        sourceUrl: grid.sourceUrl ?? "",
        validFrom: toIsoDate(grid.validFrom),
        validTo: grid.validTo ? toIsoDate(grid.validTo) : "",
        notes: grid.notes ?? "",
      }
    : {
        vehicleType: "TAXI",
        department: "",
        certified: "",
        zone: "",
        label: "",
        baseFare: "",
        aggloFare: "",
        bigCityFare: "",
        includedKm: "0",
        pricePerKm: "",
        shortTripBands: "",
        nightRate: "0",
        weekendRate: "0",
        nightStart: "20:00",
        nightEnd: "08:00",
        saturdayFrom: "12:00",
        surchargeShortTrip: "on",
        emptyLegRateShort: "",
        emptyLegRateLong: "",
        emptyLegThresholdKm: "50",
        discount2: "",
        discount3: "",
        discount4: "",
        maxSharedPatients: "3",
        aloneDiscount: "",
        aloneThresholdKm: "30",
        billableDetourKm: "",
        tpmrFare: "",
        verification: "UNVERIFIED",
        sourceUrl: "",
        validFrom: "",
        validTo: "",
        notes: "",
      };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) base[key] = value;
  }
  return base;
}

/** The grid typed so far as fare.ts reads it, or null while an amount is missing or invalid. */
export function previewFareGrid(get: (name: string) => string): FareGrid | null {
  const values = Object.fromEntries(Object.keys(tariffFormValues()).map((key) => [key, get(key)]));
  // The preview only reads the amounts: the scope, the dates and the texts must not hide it.
  const neutral = { department: "*", validFrom: "2026-01-01", validTo: "", label: "", notes: "", sourceUrl: "", zone: "" };
  const parsed = tariffSchema.safeParse({ ...values, ...neutral });
  return parsed.success ? toPreview(parsed.data) : null;
}

function toPreview(grid: TariffInput): FareGrid {
  return {
    baseFare: grid.baseFare,
    aggloFare: grid.aggloFare,
    bigCityFare: grid.bigCityFare,
    includedKm: grid.includedKm,
    pricePerKm: grid.pricePerKm,
    shortTripBands: grid.shortTripBands,
    nightRate: grid.nightRate,
    weekendRate: grid.weekendRate,
    nightStartMinute: grid.nightStartMinute,
    nightEndMinute: grid.nightEndMinute,
    saturdayFromMinute: grid.saturdayFromMinute,
    surchargeShortTrip: grid.surchargeShortTrip,
    emptyLegRateShort: grid.emptyLegRateShort,
    emptyLegRateLong: grid.emptyLegRateLong,
    emptyLegThresholdKm: grid.emptyLegThresholdKm,
    sharedDiscounts: grid.sharedDiscounts,
    maxSharedPatients: grid.maxSharedPatients,
    aloneDiscount: grid.aloneDiscount,
    aloneThresholdKm: grid.aloneThresholdKm,
    billableDetourKm: grid.billableDetourKm,
    tpmrFare: grid.tpmrFare,
  };
}

export type TariffStatus = "IN_FORCE" | "UPCOMING" | "EXPIRED" | "SUPERSEDED";

export const TARIFF_STATUS_LABELS: Record<TariffStatus, string> = {
  IN_FORCE: "En vigueur aujourd'hui",
  UPCOMING: "À venir",
  EXPIRED: "Expirée",
  SUPERSEDED: "Remplacée",
};

/**
 * Status of a grid on `isoDate`, given the ids returned by tariffsInForce():
 * a grid inside its validity that is not in force was overridden by a more
 * recent grid for the same vehicle type, department and certification.
 */
export function tariffStatus(
  grid: Pick<TariffGrid, "id" | "validFrom" | "validTo">,
  isoDate: string,
  inForceIds: ReadonlySet<string>,
): TariffStatus {
  if (inForceIds.has(grid.id)) return "IN_FORCE";
  if (toIsoDate(grid.validFrom) > isoDate) return "UPCOMING";
  if (grid.validTo && toIsoDate(grid.validTo) < isoDate) return "EXPIRED";
  return "SUPERSEDED";
}
