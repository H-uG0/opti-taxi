"use client";

import { useActionState } from "react";
import type { VehicleType } from "@prisma/client";
import { Badge, VehicleTypeBadge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage, Select } from "@/components/ui/form";
import { TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE, valueOf } from "@/lib/forms";
import type { CrewIssue, CrewSource } from "@/lib/staff/day-crews";
import { saveDayCrews } from "./actions";
import { crewMateField, driverField, SOURCE_LABELS } from "./schema";

export type CrewPersonOption = {
  id: string;
  name: string;
  active: boolean;
  depotId: string | null;
  /** "congé du … au …", or null when not absent that day. */
  absence: string | null;
  worksThatDay: boolean;
  canDrive: Record<VehicleType, boolean>;
  canCrew: boolean;
};

export type CrewRow = {
  vehicleId: string;
  label: string;
  registration: string;
  type: VehicleType;
  depotId: string;
  depotName: string;
  driverId: string | null;
  crewMateId: string | null;
  source: CrewSource;
  issues: CrewIssue[];
  blocked: string | null;
};

const SOURCE_TONES: Record<CrewSource, BadgeTone> = { saved: "brand", default: "neutral", replacement: "info", none: "danger" };

function optionLabel(person: CrewPersonOption, row: CrewRow, seat: "driver" | "crewMate"): string {
  const notes: string[] = [];
  if (!person.active) notes.push("désactivé");
  if (person.absence) notes.push(person.absence);
  else if (!person.worksThatDay) notes.push("hors de ses jours habituels");
  if (!(seat === "driver" ? person.canDrive[row.type] : person.canCrew)) notes.push("non qualifié");
  if (person.depotId !== row.depotId) notes.push("autre dépôt");
  return notes.length > 0 ? `${person.name} (${notes.join(", ")})` : person.name;
}

export function CrewForm({
  date,
  rows,
  people,
  locked,
  hasSavedCrews,
}: {
  date: string;
  rows: CrewRow[];
  people: CrewPersonOption[];
  /** Why the crews of this date can no longer change, or null. */
  locked: string | null;
  hasSavedCrews: boolean;
}) {
  const [state, formAction] = useActionState(saveDayCrews, IDLE_STATE);
  const echoed = state.status === "error" ? state.values : null;
  const errors = state.fieldErrors;

  return (
    // Remount on every response so the selects show the echoed values.
    <form key={state.submissionId} action={formAction} className="space-y-4">
      <input type="hidden" name="date" value={date} />
      {state.status === "error" && state.message ? <FormMessage>{state.message}</FormMessage> : null}
      {state.status === "success" && state.message ? <FormMessage tone="success">{state.message}</FormMessage> : null}
      <fieldset disabled={locked !== null} className="space-y-4">
        <Table>
          <THead>
            <tr>
              <Th>Véhicule</Th>
              <Th>Chauffeur</Th>
              <Th>Équipier</Th>
              <Th>Origine</Th>
              <Th>Remarques</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((row, index) => {
              const depotHeader = index === 0 || rows[index - 1]?.depotId !== row.depotId;
              const driverValue = echoed ? valueOf(echoed, driverField(row.vehicleId)) : (row.driverId ?? "");
              const mateValue = echoed ? valueOf(echoed, crewMateField(row.vehicleId)) : (row.crewMateId ?? "");
              const driverError = errors[driverField(row.vehicleId)];
              const mateError = errors[crewMateField(row.vehicleId)];
              return [
                depotHeader ? (
                  <tr key={`depot-${row.depotId}`} className="bg-slate-50">
                    <Td colSpan={5} className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
                      Dépôt {row.depotName}
                    </Td>
                  </tr>
                ) : null,
                <tr key={row.vehicleId} className={row.blocked ? "bg-red-50/40" : undefined}>
                  <Td className="whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      <VehicleTypeBadge type={row.type} />
                      <span className="font-medium text-slate-900">{row.label}</span>
                    </span>
                    <span className="font-mono text-xs text-slate-500">{row.registration}</span>
                  </Td>
                  <Td className="min-w-56">
                    <Select
                      name={driverField(row.vehicleId)}
                      defaultValue={driverValue}
                      aria-label={`Chauffeur de ${row.label}`}
                      aria-invalid={Boolean(driverError)}
                    >
                      <option value="">— Personne (reste au dépôt) —</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {optionLabel(p, row, "driver")}
                        </option>
                      ))}
                    </Select>
                    {driverError ? <p className="mt-1 text-xs font-medium text-red-700">{driverError}</p> : null}
                  </Td>
                  <Td className="min-w-56">
                    {row.type === "AMBULANCE" ? (
                      <>
                        <Select
                          name={crewMateField(row.vehicleId)}
                          defaultValue={mateValue}
                          aria-label={`Équipier de ${row.label}`}
                          aria-invalid={Boolean(mateError)}
                        >
                          <option value="">— Aucun équipier —</option>
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {optionLabel(p, row, "crewMate")}
                            </option>
                          ))}
                        </Select>
                        {mateError ? <p className="mt-1 text-xs font-medium text-red-700">{mateError}</p> : null}
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={SOURCE_TONES[row.source]}>{SOURCE_LABELS[row.source]}</Badge>
                  </Td>
                  <Td className="text-xs">
                    {row.issues.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {row.issues.map((issue, i) => (
                          <li key={i} className={issue.level === "error" ? "font-medium text-red-700" : "text-slate-600"}>
                            {issue.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Td>
                </tr>,
              ];
            })}
          </TBody>
        </Table>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-4">
          <p className="mr-auto text-xs text-slate-500">
            Enregistrer fige l&apos;équipage de chaque véhicule pour ce jour, tel qu&apos;affiché. L&apos;optimisation
            l&apos;utilise ensuite tel quel.
          </p>
          {hasSavedCrews ? (
            <Button type="submit" name="intent" value="reset" variant="secondary">
              Revenir aux propositions
            </Button>
          ) : null}
          <SubmitButton name="intent" value="save" pendingLabel="Enregistrement…">
            Enregistrer les équipages
          </SubmitButton>
        </div>
      </fieldset>
    </form>
  );
}
