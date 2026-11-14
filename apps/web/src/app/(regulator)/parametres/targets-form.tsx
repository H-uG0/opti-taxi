"use client";

import { useActionState } from "react";
import { FormMessage, UnitInput } from "@/components/ui/form";
import { Table, TBody, Td, Th, THead } from "@/components/ui/table";
import { ErrorFocus } from "@/components/ui/error-focus";
import { FormFooter } from "@/components/ui/form-footer";
import { IDLE_STATE, refusalKey, valueOf, type FormState, type FormValues } from "@/lib/forms";
import { INDICATOR_KEYS, inputBounds, KPI_INDICATORS, targetField, type KpiIndicator } from "@/lib/kpis-targets";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/**
 * Reference value and objective of each indicator of the dashboard for one
 * scope (the company or a depot). Blank: no line drawn (a depot then reads
 * the company's value).
 */
export function TargetsForm({
  action,
  initial,
  companyValues,
  depotName,
}: {
  action: Action;
  initial: FormValues;
  /** The company's values, shown as placeholders when a depot is edited. */
  companyValues: FormValues | null;
  depotName: string | null;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;
  const field = (indicator: KpiIndicator, kind: "reference" | "objective") => {
    const name = targetField(indicator, kind);
    const { suffix } = inputBounds(KPI_INDICATORS[indicator].unit);
    const error = state.fieldErrors[name];
    const company = companyValues ? valueOf(companyValues, name) : "";
    return (
      <div className="space-y-1">
        <UnitInput
          id={name}
          name={name}
          unit={suffix}
          inputMode="decimal"
          defaultValue={valueOf(values, name)}
          placeholder={company || (indicator === "sharedRate" && kind === "objective" && !depotName ? "30" : undefined)}
          aria-label={`${kind === "reference" ? "Référence" : "Objectif"}, ${KPI_INDICATORS[indicator].label}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${name}-error` : undefined}
          // A long unit (« courses ») takes the room of the digits in a narrow field.
          className={suffix.length > 4 ? "w-44" : "w-32"}
        />
        {error ? (
          <p id={`${name}-error`} className="text-xs text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    );
  };
  return (
    <form key={state.submissionId} action={formAction} className="space-y-4">
      <ErrorFocus refusal={refusalKey(state)} />
      {state.message ? <FormMessage tone={state.status === "error" ? "error" : "success"}>{state.message}</FormMessage> : null}
      <Table>
        <THead>
          <tr>
            <Th>Indicateur</Th>
            <Th title="Valeur mesurée avant l'outil, sur l'historique de V">Référence</Th>
            <Th title="Valeur visée">Objectif</Th>
          </tr>
        </THead>
        <TBody>
          {INDICATOR_KEYS.map((indicator) => (
            <tr key={indicator}>
              <Td className="align-top">
                <span className="block font-medium text-slate-900">{KPI_INDICATORS[indicator].label}</span>
                <span className="block text-xs text-slate-500">
                  {KPI_INDICATORS[indicator].help}
                  {KPI_INDICATORS[indicator].higherIsBetter ? "" : " · plus bas = mieux"}
                </span>
              </Td>
              <Td className="align-top">{field(indicator, "reference")}</Td>
              <Td className="align-top">{field(indicator, "objective")}</Td>
            </tr>
          ))}
        </TBody>
      </Table>
      <FormFooter submitLabel={depotName ? `Enregistrer pour ${depotName}` : "Enregistrer les objectifs"} />
    </form>
  );
}
