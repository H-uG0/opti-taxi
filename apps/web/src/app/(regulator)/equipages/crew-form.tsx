"use client";

import { useActionState, useState, type ChangeEvent } from "react";
import type { VehicleType } from "@prisma/client";
import { Undo2 } from "lucide-react";
import { Badge, VehicleTypeBadge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage, Select } from "@/components/ui/form";
import { TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE_STATE, valueOf, type FieldErrors, type FormValues } from "@/lib/forms";
import { formatInstant } from "@/lib/planning/format";
import { shiftText, type CrewIssue, type Seat } from "@/lib/staff/day-crews";
import { saveDayCrews } from "./actions";
import {
  crewMateField,
  driverField,
  ORIGIN_LABELS,
  shownCrewMateField,
  shownDriverField,
  UNFIX_INTENT,
  versionField,
  type CrewOrigin,
} from "./schema";

export type CrewPersonOption = {
  id: string;
  name: string;
  active: boolean;
  depotId: string | null;
  /** "absence du … au …", or null when not absent that day. */
  absence: string | null;
  worksThatDay: boolean;
  canDrive: Record<VehicleType, boolean>;
  canCrew: boolean;
  /** Label of the vehicle the person is on that day (crew of the day), or null. */
  vehicleId: string | null;
  vehicleLabel: string | null;
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
  origin: CrewOrigin;
  /** Seats holding a replacement the tool proposes. */
  proposedSeats: Seat[];
  /** Fixed crew: version (DayCrew.updatedAt, ISO) and author; null for a proposal. */
  fixed: { version: string; by: string | null } | null;
  /** Working hours of the crew of the day. */
  shift: { start: number; end: number } | null;
  issues: CrewIssue[];
  blocked: string | null;
  /** Out of service that day: no crew to choose. */
  unavailable: boolean;
};

const ORIGIN_TONES: Record<CrewOrigin, BadgeTone> = {
  fixed: "brand",
  parked: "neutral",
  default: "neutral",
  replacement: "info",
  none: "danger",
};

function optionLabel(person: CrewPersonOption, row: CrewRow, seat: Seat): string {
  const notes: string[] = [];
  if (!person.active) notes.push("désactivé");
  if (person.absence) notes.push(person.absence);
  else if (!person.worksThatDay) notes.push("hors de ses jours habituels");
  if (!(seat === "driver" ? person.canDrive[row.type] : person.canCrew)) notes.push("non qualifié");
  if (person.vehicleLabel && person.vehicleId !== row.vehicleId) notes.push(`sur ${person.vehicleLabel}`);
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
    <CrewFormBody
      key={state.submissionId}
      date={date}
      rows={rows}
      people={people}
      locked={locked}
      hasSavedCrews={hasSavedCrews}
      action={formAction}
      echoed={echoed}
      errors={errors}
      message={state.message ? { tone: state.status === "error" ? "error" : "success", text: state.message } : null}
    />
  );
}

function CrewFormBody({
  date,
  rows,
  people,
  locked,
  hasSavedCrews,
  action,
  echoed,
  errors,
  message,
}: {
  date: string;
  rows: CrewRow[];
  people: CrewPersonOption[];
  locked: string | null;
  hasSavedCrews: boolean;
  action: (formData: FormData) => void;
  echoed: FormValues | null;
  errors: FieldErrors;
  message: { tone: "error" | "success"; text: string } | null;
}) {
  const shownValue = (row: CrewRow, seat: Seat) => (seat === "driver" ? row.driverId : row.crewMateId) ?? "";
  // Rows whose selects differ from the crew shown: only they are written.
  const [dirty, setDirty] = useState<Set<string>>(
    () =>
      new Set(
        echoed
          ? rows
              .filter(
                (row) =>
                  !row.unavailable &&
                  (valueOf(echoed, driverField(row.vehicleId)) !== shownValue(row, "driver") ||
                    (row.type === "AMBULANCE" && valueOf(echoed, crewMateField(row.vehicleId)) !== shownValue(row, "crewMate"))),
              )
              .map((row) => row.vehicleId)
          : [],
      ),
  );

  const onSeatChange = (row: CrewRow) => (event: ChangeEvent<HTMLSelectElement>) => {
    const form = event.currentTarget.form;
    if (!form) return;
    const current = (field: string) => (form.elements.namedItem(field) as HTMLSelectElement | null)?.value ?? "";
    const changed =
      current(driverField(row.vehicleId)) !== shownValue(row, "driver") ||
      (row.type === "AMBULANCE" && current(crewMateField(row.vehicleId)) !== shownValue(row, "crewMate"));
    setDirty((previous) => {
      if (previous.has(row.vehicleId) === changed) return previous;
      const next = new Set(previous);
      if (changed) next.add(row.vehicleId);
      else next.delete(row.vehicleId);
      return next;
    });
  };

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="date" value={date} />
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      <fieldset disabled={locked !== null} className="space-y-4">
        <Table>
          <THead>
            <tr>
              <Th>Véhicule</Th>
              <Th>Chauffeur</Th>
              <Th>Équipier</Th>
              <Th>Horaire</Th>
              <Th>Origine</Th>
              <Th>Remarques</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((row, index) => {
              const depotHeader = index === 0 || rows[index - 1]?.depotId !== row.depotId;
              const driverValue = echoed ? valueOf(echoed, driverField(row.vehicleId)) : shownValue(row, "driver");
              const mateValue = echoed ? valueOf(echoed, crewMateField(row.vehicleId)) : shownValue(row, "crewMate");
              const driverError = errors[driverField(row.vehicleId)];
              const mateError = errors[crewMateField(row.vehicleId)];
              const isDirty = dirty.has(row.vehicleId);
              const hasError = row.issues.some((issue) => issue.level === "error") && !row.unavailable;
              return [
                depotHeader ? (
                  <tr key={`depot-${row.depotId}`} className="bg-slate-50">
                    <Td colSpan={6} className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
                      Dépôt {row.depotName}
                    </Td>
                  </tr>
                ) : null,
                <tr key={row.vehicleId} className={isDirty ? "bg-amber-50/60" : hasError ? "bg-red-50/40" : undefined}>
                  <Td className="whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      <VehicleTypeBadge type={row.type} />
                      <span className="font-medium text-slate-900">{row.label}</span>
                    </span>
                    <span className="font-mono text-xs text-slate-500">{row.registration}</span>
                  </Td>
                  {row.unavailable ? (
                    <Td colSpan={3} className="text-sm text-slate-500">
                      Véhicule indisponible ce jour : pas d&apos;équipage.{" "}
                      <a href={`/vehicules/${row.vehicleId}`} className="underline">
                        Voir la fiche
                      </a>
                    </Td>
                  ) : (
                    <>
                      <Td className="min-w-48">
                        <input type="hidden" name={shownDriverField(row.vehicleId)} value={shownValue(row, "driver")} />
                        <input type="hidden" name={versionField(row.vehicleId)} value={row.fixed?.version ?? ""} />
                        <Select
                          name={driverField(row.vehicleId)}
                          defaultValue={driverValue}
                          onChange={onSeatChange(row)}
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
                      <Td className="min-w-48">
                        {row.type === "AMBULANCE" ? (
                          <>
                            <input type="hidden" name={shownCrewMateField(row.vehicleId)} value={shownValue(row, "crewMate")} />
                            <Select
                              name={crewMateField(row.vehicleId)}
                              defaultValue={mateValue}
                              onChange={onSeatChange(row)}
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
                      <Td className="tabular text-sm whitespace-nowrap text-slate-700">
                        {row.shift ? shiftText(row.shift) : <span className="text-slate-400">—</span>}
                      </Td>
                    </>
                  )}
                  <Td>
                    <span className="flex flex-col items-start gap-1">
                      <span className="flex flex-wrap gap-1">
                        <Badge tone={row.unavailable ? "warning" : ORIGIN_TONES[row.origin]} className="whitespace-nowrap">
                          {row.unavailable ? "Indisponible" : ORIGIN_LABELS[row.origin]}
                        </Badge>
                        {row.fixed && row.proposedSeats.length > 0 ? (
                          <Badge tone="info" className="whitespace-nowrap">
                            Remplaçant proposé
                          </Badge>
                        ) : null}
                        {isDirty ? <Badge tone="warning">Modifié</Badge> : null}
                      </span>
                      {row.fixed && !row.unavailable ? (
                        <>
                          <span className="max-w-40 text-xs text-slate-500">
                            {row.fixed.by ? `par ${row.fixed.by}, ` : ""}le {formatInstant(row.fixed.version)}
                          </span>
                          <Button
                            type="submit"
                            name="intent"
                            value={`${UNFIX_INTENT}${row.vehicleId}`}
                            variant="ghost"
                            size="sm"
                            className="-ml-2.5 text-xs whitespace-nowrap"
                            // Submitting it would drop the other rows' changes: save them first.
                            disabled={dirty.size > 0}
                            title={
                              dirty.size > 0
                                ? "Enregistrez d'abord vos modifications"
                                : "Oublier l'équipage fixé de ce véhicule : il reprend la proposition automatique"
                            }
                          >
                            <Undo2 aria-hidden className="size-3.5" />
                            Revenir à la proposition
                          </Button>
                        </>
                      ) : null}
                    </span>
                  </Td>
                  <Td className="min-w-48 text-xs">
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
          <p className="mr-auto max-w-2xl text-xs text-slate-500">
            Seules les lignes modifiées sont enregistrées et deviennent des équipages fixés : l&apos;optimisation les utilise
            tels quels, et propose un remplaçant si une personne fixée devient absente. Les autres lignes restent des
            propositions qui suivent les absences.
          </p>
          {hasSavedCrews ? (
            <Button type="submit" name="intent" value="reset" variant="secondary">
              Revenir aux propositions (tout le jour)
            </Button>
          ) : null}
          <SubmitButton name="intent" value="save" pendingLabel="Enregistrement…" disabled={dirty.size === 0}>
            {dirty.size === 0
              ? "Aucune modification"
              : `Enregistrer ${dirty.size > 1 ? `les ${dirty.size} modifications` : "la modification"}`}
          </SubmitButton>
        </div>
      </fieldset>
    </form>
  );
}
