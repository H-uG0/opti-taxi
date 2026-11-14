/**
 * Form of the reference values and objectives of the dashboard (KPI-09), for
 * the whole company or one depot: two optional numbers per indicator (a rate
 * typed in percent). Pure module, unit-tested.
 */
import { z } from "zod";
import { optionalNumberField, formatDecimalInput, type FormValues } from "@/lib/forms";
import {
  fromInputValue,
  INDICATOR_KEYS,
  inputBounds,
  KPI_INDICATORS,
  targetField,
  toInputValue,
  type KpiIndicator,
  type TargetRow,
} from "@/lib/kpis-targets";

export function targetsSchema() {
  const shape: Record<string, z.ZodType> = {};
  for (const indicator of INDICATOR_KEYS) {
    const { min, max, suffix } = inputBounds(KPI_INDICATORS[indicator].unit);
    shape[targetField(indicator, "reference")] = optionalNumberField({ min, max, unit: suffix });
    shape[targetField(indicator, "objective")] = optionalNumberField({ min, max, unit: suffix });
  }
  return z.object(shape);
}

/** The values of a scope as typed in the form ("" where none). */
export function targetsFormValues(rows: readonly TargetRow[], depotId: string | null): FormValues {
  const values: FormValues = {};
  for (const indicator of INDICATOR_KEYS) {
    const row = rows.find((r) => r.indicator === indicator && r.depotId === depotId);
    const unit = KPI_INDICATORS[indicator].unit;
    values[targetField(indicator, "reference")] = toInputValue(unit, row?.reference ?? null);
    values[targetField(indicator, "objective")] = toInputValue(unit, row?.objective ?? null);
  }
  return values;
}

/** The rows to store for a scope: one per indicator with a value (rates back to fractions). */
export function toTargetRows(parsed: Record<string, unknown>, depotId: string | null): TargetRow[] {
  return INDICATOR_KEYS.flatMap((indicator: KpiIndicator) => {
    const unit = KPI_INDICATORS[indicator].unit;
    const read = (field: "reference" | "objective") => {
      const value = parsed[targetField(indicator, field)];
      return typeof value === "number" ? fromInputValue(unit, value) : null;
    };
    const reference = read("reference");
    const objective = read("objective");
    return reference === null && objective === null ? [] : [{ indicator, depotId, reference, objective }];
  });
}

/** Audit details of a change: « indicator.field » from → to, in the typed unit ("" for none). */
export function targetChanges(previous: readonly TargetRow[], next: readonly TargetRow[]): Record<string, { from: string; to: string }> {
  const changes: Record<string, { from: string; to: string }> = {};
  for (const indicator of INDICATOR_KEYS) {
    const before = previous.find((r) => r.indicator === indicator);
    const after = next.find((r) => r.indicator === indicator);
    for (const field of ["reference", "objective"] as const) {
      const from = formatDecimalInput(before?.[field] ?? null);
      const to = formatDecimalInput(after?.[field] ?? null);
      if (from !== to) changes[`${indicator}.${field}`] = { from, to };
    }
  }
  return changes;
}
