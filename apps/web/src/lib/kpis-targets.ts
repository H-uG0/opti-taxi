/**
 * Reference values and objectives of the dashboard indicators (KPI-09). Pure.
 *
 * The reference is the value measured before the tool (on V's history), the
 * objective the one V aims at; both are entered in Paramètres (KpiTarget),
 * for the whole company or a depot, and V provides them. They are drawn
 * dashed on the trend charts and the gap shows in the tiles. A depot without
 * its own value reads the company's; the shared transport has, by default,
 * the objective of the protocol of 24 September 2025 (more than 30 % at the
 * end of 2027). Rates are fractions (0.3 = 30 %), times minutes, money euros.
 */
import { SHARING_OBJECTIVE } from "./kpis-sharing";

export type IndicatorUnit = "rate" | "decimal" | "minutes" | "euros";

export type IndicatorDefinition = {
  label: string;
  unit: IndicatorUnit;
  /** A higher value is better (false: km à vide, retards, temps de planification). */
  higherIsBetter: boolean;
  /** What the value measures, under the field in Paramètres. */
  help: string;
};

/** The indicators that take a reference and an objective, in the order of the charts. */
export const KPI_INDICATORS = {
  serviceRate: {
    label: "Taux de service",
    unit: "rate",
    higherIsBetter: true,
    help: "Courses placées ÷ courses à transporter",
  },
  tripsPerVehicle: {
    label: "Courses par véhicule et par jour",
    unit: "decimal",
    higherIsBetter: true,
    help: "Courses servies ÷ véhicules utilisés",
  },
  useRate: {
    label: "Utilisation de la flotte",
    unit: "rate",
    higherIsBetter: true,
    help: "Véhicules utilisés ÷ véhicules disponibles",
  },
  emptyKmShare: {
    label: "Part des km à vide",
    unit: "rate",
    higherIsBetter: false,
    help: "Km sans patient ÷ km des tournées",
  },
  sharedRate: {
    label: "Transport partagé (CPAM)",
    unit: "rate",
    higherIsBetter: true,
    help: "Courses partagées ÷ courses éligibles en taxi ou VSL",
  },
  lateRate: {
    label: "Retards au RDV",
    unit: "rate",
    higherIsBetter: false,
    help: "Allers déposés après le RDV et la tolérance",
  },
  planningMinutes: {
    label: "Temps de planification",
    unit: "minutes",
    higherIsBetter: false,
    help: "Temps actif de construction du planning d'une journée",
  },
  marginPerTrip: {
    label: "Marge par course",
    unit: "euros",
    higherIsBetter: true,
    help: "(CA estimé − coût des tournées) ÷ courses servies",
  },
} as const satisfies Record<string, IndicatorDefinition>;

export type KpiIndicator = keyof typeof KPI_INDICATORS;

export const INDICATOR_KEYS = Object.keys(KPI_INDICATORS) as KpiIndicator[];

export function isIndicator(value: string): value is KpiIndicator {
  return (INDICATOR_KEYS as string[]).includes(value);
}

/** A stored row (KpiTarget). */
export type TargetRow = { indicator: string; depotId: string | null; reference: number | null; objective: number | null };

/** Where a value comes from: the depot's own, the company's, or the protocol (shared transport only). */
export type TargetSource = "depot" | "company" | "protocol";

export type EffectiveTarget = {
  reference: number | null;
  objective: number | null;
  referenceSource: TargetSource | null;
  objectiveSource: TargetSource | null;
};

export type EffectiveTargets = Record<KpiIndicator, EffectiveTarget>;

/**
 * The values that apply to the dashboard of `depotId` (null: the whole
 * company): each value of the depot's row, else of the company's, else the
 * protocol's objective for the shared transport.
 */
export function effectiveTargets(rows: readonly TargetRow[], depotId: string | null): EffectiveTargets {
  const pick = (indicator: KpiIndicator, depot: string | null) => rows.find((r) => r.indicator === indicator && r.depotId === depot);
  const result = {} as EffectiveTargets;
  for (const indicator of INDICATOR_KEYS) {
    const own = depotId ? pick(indicator, depotId) : undefined;
    const company = pick(indicator, null);
    const value = (field: "reference" | "objective"): [number | null, TargetSource | null] => {
      const ownValue = own?.[field];
      if (ownValue !== null && ownValue !== undefined) return [ownValue, "depot"];
      const companyValue = company?.[field];
      if (companyValue !== null && companyValue !== undefined) return [companyValue, "company"];
      if (field === "objective" && indicator === "sharedRate") return [SHARING_OBJECTIVE, "protocol"];
      return [null, null];
    };
    const [reference, referenceSource] = value("reference");
    const [objective, objectiveSource] = value("objective");
    result[indicator] = { reference, objective, referenceSource, objectiveSource };
  }
  return result;
}

/** value - target, null when either is unknown. */
export function targetGap(value: number | null | undefined, target: number | null | undefined): number | null {
  if (value === null || value === undefined || target === null || target === undefined) return null;
  if (!Number.isFinite(value) || !Number.isFinite(target)) return null;
  return value - target;
}

/** Whether a value reaches its objective (null: unknown). */
export function meetsObjective(indicator: KpiIndicator, value: number | null | undefined, objective: number | null | undefined): boolean | null {
  const gap = targetGap(value, objective);
  if (gap === null) return null;
  return KPI_INDICATORS[indicator].higherIsBetter ? gap >= -1e-9 : gap <= 1e-9;
}

// ---------------------------------------------------------------------------
// The form of Paramètres: rates typed in percent, the rest as is.

/** Bounds of a typed value (in the unit typed). */
export function inputBounds(unit: IndicatorUnit): { min: number; max: number; suffix: string } {
  switch (unit) {
    case "rate":
      return { min: 0, max: 100, suffix: "%" };
    case "decimal":
      return { min: 0, max: 50, suffix: "courses" };
    case "minutes":
      return { min: 0, max: 1440, suffix: "min" };
    case "euros":
      return { min: -1000, max: 1000, suffix: "€" };
  }
}

/** A stored value as typed in the form (a rate in percent, decimal comma), "" when none. */
export function toInputValue(unit: IndicatorUnit, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const typed = unit === "rate" ? Math.round(value * 1000) / 10 : Math.round(value * 100) / 100;
  return String(typed).replace(".", ",");
}

/** A typed value as stored (a percent becomes a fraction). */
export function fromInputValue(unit: IndicatorUnit, typed: number): number {
  return unit === "rate" ? Math.round(typed * 10) / 1000 : typed;
}

/** Field names of the form. */
export function targetField(indicator: KpiIndicator, field: "reference" | "objective"): string {
  return `${indicator}-${field}`;
}
