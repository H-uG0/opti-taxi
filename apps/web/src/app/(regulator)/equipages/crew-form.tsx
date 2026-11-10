"use client";

import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { VehicleType } from "@prisma/client";
import { Pin, Undo2 } from "lucide-react";
import { Badge, VehicleTypeBadge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { FilterBar, FilterCheckbox, FilterSelect } from "@/components/ui/filter-bar";
import { FormMessage } from "@/components/ui/form";
import { LeaveGuard } from "@/components/ui/leave-guard";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { GroupHeaderRow, TBody, THead, Table, Td, Th } from "@/components/ui/table";
import { IDLE_STATE, PENDING_LABEL, SAVING_LABEL, valueOf, type FieldErrors, type FormValues } from "@/lib/forms";
import { shiftText, type CrewIssue, type Seat } from "@/lib/staff/day-crews";
import { formatDateTime, formatShortDate } from "@/lib/time";
import { saveDayCrews } from "./actions";
import { assignmentsOf, seatOptions, type CrewPersonOption, type DepotInfo } from "./person-options";
import {
  crewMateField,
  driverField,
  FIX_INTENT,
  ORIGIN_LABELS,
  PARK_VALUE,
  shownCrewMateField,
  shownDriverField,
  UNFIX_INTENT,
  versionField,
  type CrewOrigin,
} from "./schema";
import { depotSummaries, needsAttention, parseCrewFilter, TO_HANDLE, type DepotSummary } from "./summary";

export type { CrewPersonOption } from "./person-options";

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
  /**
   * Version of the vehicle's DayCrew row, even when the vehicle is out of
   * service that day (its old row is not offered, but « Revenir aux
   * propositions » removes it too); null without a row.
   */
  savedVersion: string | null;
  /** Working hours of the crew of the day. */
  shift: { start: number; end: number } | null;
  issues: CrewIssue[];
  blocked: string | null;
  /** Out of service that day: no crew to choose. */
  unavailable: boolean;
  /** « Équipage à revoir » of the planning (a change since the routes were computed, an overdue deadline). */
  flagged: boolean;
};

/** Depot names and straight-line distances between depots (km), for the choices of a seat. */
export type CrewDepots = { names: Record<string, string>; km: Record<string, Record<string, number>> };

const ORIGIN_TONES: Record<CrewOrigin, BadgeTone> = {
  fixed: "brand",
  parked: "neutral",
  default: "neutral",
  replacement: "info",
  none: "danger",
};

const COLUMNS = 6;

/** The « Horaire » column from 1 440 px; below, the hours go under the driver's seat (the table fits at 1 280 px). */
const WIDE_ONLY = "hidden min-[1440px]:table-cell";

type SeatValues = { driver: string; mate: string };

type CrewFormProps = {
  date: string;
  rows: CrewRow[];
  people: CrewPersonOption[];
  depots: CrewDepots;
  /** Why the crews of this date can no longer change, or null. */
  locked: string | null;
  hasSavedCrews: boolean;
};

/**
 * The crews of one date. Keyed by the date: the date arrows navigate on the
 * client and Next.js keeps the page's state across a change of address, so
 * without the key the seats chosen (and the last answer) of one day would
 * show, and be saved, on the next.
 */
export function CrewForm(props: CrewFormProps) {
  return <CrewFormOfDate key={props.date} {...props} />;
}

function CrewFormOfDate({ date, rows, people, depots, locked, hasSavedCrews }: CrewFormProps) {
  const [state, formAction] = useActionState(saveDayCrews, IDLE_STATE);
  const echoed = state.status === "error" ? state.values : null;

  return (
    // Remount on every response so the seats show the echoed values (or the saved crews).
    <CrewFormBody
      key={state.submissionId}
      date={date}
      rows={rows}
      people={people}
      depots={depots}
      locked={locked}
      hasSavedCrews={hasSavedCrews}
      action={formAction}
      echoed={echoed}
      errors={state.fieldErrors}
      message={state.message ? { tone: state.status === "error" ? "error" : "success", text: state.message } : null}
    />
  );
}

function shownValue(row: CrewRow, seat: Seat): string {
  return seat === "driver" && row.origin === "parked" ? PARK_VALUE : ((seat === "driver" ? row.driverId : row.crewMateId) ?? "");
}

function isDirty(row: CrewRow, value: SeatValues | undefined): boolean {
  if (row.unavailable || !value) return false;
  const park = value.driver === PARK_VALUE;
  return value.driver !== shownValue(row, "driver") || (row.type === "AMBULANCE" && !park && value.mate !== shownValue(row, "crewMate"));
}

function CrewFormBody({
  date,
  rows,
  people,
  depots,
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
  depots: CrewDepots;
  locked: string | null;
  hasSavedCrews: boolean;
  action: (formData: FormData) => void;
  echoed: FormValues | null;
  errors: FieldErrors;
  message: { tone: "error" | "success"; text: string } | null;
}) {
  const params = useSearchParams();
  const depotIds = useMemo(() => new Set(rows.map((r) => r.depotId)), [rows]);
  const filter = parseCrewFilter(params, depotIds);
  const depotInfo: DepotInfo = useMemo(
    () => ({
      names: new Map(Object.entries(depots.names)),
      km: new Map(Object.entries(depots.km).map(([id, row]) => [id, new Map(Object.entries(row))])),
    }),
    [depots],
  );
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  // The seats as chosen: the form's state (rows hidden by a filter keep theirs).
  const [values, setValues] = useState<Map<string, SeatValues>>(
    () =>
      new Map(
        rows.map((row) => [
          row.vehicleId,
          echoed
            ? { driver: valueOf(echoed, driverField(row.vehicleId)), mate: valueOf(echoed, crewMateField(row.vehicleId)) }
            : { driver: shownValue(row, "driver"), mate: shownValue(row, "crewMate") },
        ]),
      ),
  );
  const [confirmingReset, setConfirmingReset] = useState(false);
  // « Garder les équipages » gives the focus back to the button that asked.
  const resetButton = useRef<HTMLButtonElement>(null);
  const refocusReset = useRef(false);
  useEffect(() => {
    if (confirmingReset || !refocusReset.current) return;
    refocusReset.current = false;
    resetButton.current?.focus();
  }, [confirmingReset]);
  const dirty = useMemo(() => new Set(rows.filter((row) => isDirty(row, values.get(row.vehicleId))).map((r) => r.vehicleId)), [rows, values]);
  const assignments = useMemo(() => assignmentsOf(rows, values), [rows, values]);
  const summaries = useMemo(() => depotSummaries(rows, values, people, assignments), [rows, values, people, assignments]);
  const flagged = useMemo(() => new Set(rows.filter((r) => r.flagged).map((r) => r.vehicleId)), [rows]);
  const withError = (row: CrewRow) => Boolean(errors[driverField(row.vehicleId)] || errors[crewMateField(row.vehicleId)]);
  // A row with a refused seat stays on screen whatever the filter: its message is there.
  const visible = rows.filter(
    (row) =>
      withError(row) ||
      ((filter.depot === null || row.depotId === filter.depot) && (!filter.toHandle || needsAttention(row, flagged, dirty))),
  );
  const toHandle = rows.filter((row) => needsAttention(row, flagged, dirty)).length;
  const errorRows = rows.filter(withError);

  // Unsaved changes are not lost without a warning: closing or reloading the tab, another page or another date.
  const leaveMessage =
    dirty.size === 0
      ? null
      : `${dirty.size > 1 ? `Les ${dirty.size} modifications` : "La modification"} des équipages du ${formatShortDate(date)} ${dirty.size > 1 ? "ne sont pas enregistrées : elles seront perdues" : "n'est pas enregistrée : elle sera perdue"} si vous quittez la page.`;

  const setSeat = (vehicleId: string, seat: Seat, value: string) =>
    setValues((previous) => {
      const next = new Map(previous);
      const current = next.get(vehicleId) ?? { driver: "", mate: "" };
      next.set(vehicleId, seat === "driver" ? { ...current, driver: value } : { ...current, mate: value });
      return next;
    });

  const fixedRows = rows.filter((row) => row.fixed !== null);
  const authors = [...new Set(fixedRows.map((row) => row.fixed?.by).filter((by): by is string => Boolean(by)))];
  const many = fixedRows.length > 1;
  const by = authors.length > 0 ? ` (par ${authors.join(", ")})` : "";
  const canFix = (row: CrewRow) => !row.unavailable && row.blocked === null && row.proposedSeats.length > 0;
  const setDepot = (depotId: string | null) => {
    const next = new URLSearchParams(window.location.search);
    if (depotId) next.set("depot", depotId);
    else next.delete("depot");
    window.history.replaceState(null, "", `${window.location.pathname}?${next.toString()}`);
  };
  const filtered = filter.depot !== null || filter.toHandle;

  return (
    <div className="space-y-3">
      <LeaveGuard message={leaveMessage} />
      <FilterBar
        action="/equipages"
        label="Filtrer les véhicules"
        resetHref={`/equipages?date=${date}`}
        filtered={filtered}
        mode="replace"
        hidden={{ date }}
      >
        <FilterSelect
          name="depot"
          label="Dépôt"
          value={filter.depot ?? ""}
          allLabel="Tous les dépôts"
          options={summaries.map((s) => ({ value: s.depotId, label: s.depotName }))}
          className="w-52"
        />
        <FilterCheckbox name="etat" value={TO_HANDLE} label={`À traiter seulement (${toHandle})`} checked={filter.toHandle} />
      </FilterBar>

      <DepotStrip summaries={summaries} selected={filter.depot} onSelect={setDepot} />

      <form action={action} className="space-y-3">
        <input type="hidden" name="date" value={date} />
        {/* min-w-0: a fieldset is as wide as its content by default, the table would widen the page instead of scrolling in its frame. */}
        <fieldset disabled={locked !== null} className="min-w-0 space-y-3">
          {/* Every row's crew as shown and as chosen, whatever the filter shows: only the changed rows are written. */}
          {rows.map((row) => (
            <SeatInputs key={row.vehicleId} row={row} value={values.get(row.vehicleId)} />
          ))}
          <p className="text-sm text-slate-600" aria-live="polite">
            {filtered ? `${visible.length} véhicule${visible.length > 1 ? "s" : ""} affiché${visible.length > 1 ? "s" : ""} sur ${rows.length}` : `${rows.length} véhicules`}
            , par dépôt, type et numéro.
          </p>
          {visible.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-8 text-center text-sm text-slate-600">
              {filter.toHandle ? "Rien à traiter pour ces filtres." : "Aucun véhicule pour ces filtres."}
            </p>
          ) : (
            <Table>
              <caption className="sr-only">Équipages du {formatShortDate(date)}, par dépôt</caption>
              <THead>
                <tr>
                  <Th>Véhicule</Th>
                  <Th>Chauffeur</Th>
                  <Th>Équipier</Th>
                  <Th className={WIDE_ONLY}>Horaire</Th>
                  <Th>Origine</Th>
                  <Th>Remarques</Th>
                </tr>
              </THead>
              <TBody>
                {visible.map((row, index) => {
                  const depotHeader = index === 0 || visible[index - 1]?.depotId !== row.depotId;
                  const summary = depotHeader ? summaries.find((s) => s.depotId === row.depotId) : undefined;
                  const value = values.get(row.vehicleId) ?? { driver: "", mate: "" };
                  const parked = value.driver === PARK_VALUE;
                  const driverError = errors[driverField(row.vehicleId)];
                  const mateError = errors[crewMateField(row.vehicleId)];
                  const changed = dirty.has(row.vehicleId);
                  const hasError = row.issues.some((issue) => issue.level === "error") && !row.unavailable;
                  const personLabel = (id: string, empty: string) =>
                    id === "" ? empty : id === PARK_VALUE ? "Laissé au dépôt ce jour" : (peopleById.get(id)?.name ?? "Personne inconnue");
                  const optionsOf = (seat: Seat) => () =>
                    seatOptions(
                      people,
                      { vehicleId: row.vehicleId, type: row.type, depotId: row.depotId, seat, otherSeatValue: seat === "driver" ? value.mate : value.driver },
                      assignments,
                      depotInfo,
                      seat === "driver" ? driverSpecial(row) : [{ value: "", label: "— Aucun équipier —" }],
                    );
                  return [
                    summary ? <DepotHeader key={`depot-${row.depotId}`} summary={summary} /> : null,
                    <tr
                      key={row.vehicleId}
                      id={`vehicule-${row.vehicleId}`}
                      className={cn("scroll-mt-40", changed ? "bg-amber-50/60" : hasError ? "bg-red-50/40" : undefined)}
                    >
                      <Td className="max-w-56">
                        <span className="flex items-center gap-2">
                          <VehicleTypeBadge type={row.type} />
                          <span className="font-medium text-slate-900">{row.label}</span>
                        </span>
                        <span className="font-mono text-xs text-slate-500">{row.registration}</span>
                      </Td>
                      {row.unavailable ? (
                        <>
                          <Td colSpan={2} className="text-sm text-slate-500">
                            Pas d&apos;équipage ce jour.{" "}
                            <Link href={`/vehicules/${row.vehicleId}`} className="underline">
                              Voir la fiche
                            </Link>
                          </Td>
                          <Td className={WIDE_ONLY} />
                        </>
                      ) : (
                        <>
                          <Td className="w-52 min-w-48">
                            <SearchSelect
                              value={value.driver}
                              onChange={(v) => setSeat(row.vehicleId, "driver", v)}
                              options={optionsOf("driver")}
                              selectedLabel={personLabel(value.driver, row.origin === "parked" ? "— Laissé au dépôt —" : "— Aucun chauffeur —")}
                              label={`Chauffeur de ${row.label}`}
                              invalid={Boolean(driverError)}
                              describedBy={driverError ? `erreur-${row.vehicleId}-driver` : undefined}
                            />
                            {driverError ? (
                              <p id={`erreur-${row.vehicleId}-driver`} className="mt-1 text-xs font-medium text-red-700">
                                {driverError}
                              </p>
                            ) : null}
                            {row.shift ? (
                              <p className="tabular mt-1 text-xs text-slate-600 min-[1440px]:hidden">
                                <span className="sr-only">Horaire : </span>
                                {shiftText(row.shift)}
                              </p>
                            ) : null}
                          </Td>
                          <Td className="w-52 min-w-48">
                            {row.type === "AMBULANCE" ? (
                              <>
                                <SearchSelect
                                  value={parked ? "" : value.mate}
                                  onChange={(v) => setSeat(row.vehicleId, "crewMate", v)}
                                  options={optionsOf("crewMate")}
                                  selectedLabel={parked ? "— Personne à bord —" : personLabel(value.mate, "— Aucun équipier —")}
                                  label={`Équipier de ${row.label}`}
                                  // Left at the depot: nobody on board.
                                  disabled={parked}
                                  invalid={Boolean(mateError)}
                                  describedBy={mateError ? `erreur-${row.vehicleId}-mate` : undefined}
                                />
                                {mateError ? (
                                  <p id={`erreur-${row.vehicleId}-mate`} className="mt-1 text-xs font-medium text-red-700">
                                    {mateError}
                                  </p>
                                ) : null}
                              </>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </Td>
                          <Td className={cn(WIDE_ONLY, "tabular text-sm whitespace-nowrap text-slate-700")}>
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
                            {changed ? <Badge tone="warning">Modifié</Badge> : null}
                          </span>
                          {canFix(row) ? (
                            <Button
                              type="submit"
                              name="intent"
                              value={`${FIX_INTENT}${row.vehicleId}`}
                              variant="ghost"
                              size="sm"
                              className="-ml-2.5 text-xs whitespace-nowrap"
                              // Submitting it would drop the other rows' changes: save them first.
                              disabled={dirty.size > 0}
                              title="Garder ce remplaçant même si les absences ou les équipages fixés changent"
                            >
                              <Pin aria-hidden className="size-3.5" />
                              Fixer cette proposition
                            </Button>
                          ) : null}
                          {row.fixed && !row.unavailable ? (
                            <>
                              <span className="max-w-40 text-xs text-slate-500">
                                {row.fixed.by ? `par ${row.fixed.by}, ` : ""}le {formatDateTime(row.fixed.version)}
                              </span>
                              <Button
                                type="submit"
                                name="intent"
                                value={`${UNFIX_INTENT}${row.vehicleId}`}
                                variant="ghost"
                                size="sm"
                                className="-ml-2.5 text-xs whitespace-nowrap"
                                // Submitting it would drop the other rows' changes: save them first (said in the bar).
                                disabled={dirty.size > 0}
                                title="Oublier l'équipage fixé de ce véhicule : il reprend la proposition automatique"
                              >
                                <Undo2 aria-hidden className="size-3.5" />
                                Revenir à la proposition
                              </Button>
                            </>
                          ) : null}
                        </span>
                      </Td>
                      <Td className="min-w-40 text-xs">
                        {row.issues.length === 0 ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {row.issues.map((issue, i) => (
                              // An out-of-service vehicle has nothing to fix here: its reason is not an alarm.
                              <li key={i} className={issue.level === "error" && !row.unavailable ? "font-medium text-red-700" : "text-slate-600"}>
                                {issue.message}
                                {issue.workTime && row.driverId ? (
                                  <Link href={`/chauffeurs/${row.driverId}`} className="block underline">
                                    Ouvrir la fiche du chauffeur
                                  </Link>
                                ) : null}
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
          )}

          {/* Always in view at the bottom of the screen: the result, the rows to fix, the changes to save. */}
          <div className="sticky bottom-0 z-20 -mx-1 space-y-2 rounded-t-lg border border-b-0 border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_12px_-6px_rgb(15_23_42/0.15)] backdrop-blur">
            {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
            {errorRows.length > 0 ? (
              <p className="text-sm text-red-800">
                À corriger :{" "}
                {errorRows.map((row, i) => (
                  <span key={row.vehicleId}>
                    {i > 0 ? ", " : null}
                    <a href={`#vehicule-${row.vehicleId}`} className="font-medium underline">
                      {row.label}
                    </a>
                  </span>
                ))}
              </p>
            ) : null}
            {confirmingReset ? (
              <div
                className="flex flex-wrap items-center justify-end gap-3"
                role="group"
                aria-label="Confirmer le retour aux propositions"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  refocusReset.current = true;
                  setConfirmingReset(false);
                }}
              >
                <p className="mr-auto max-w-3xl text-sm text-slate-800">
                  Revenir aux propositions automatiques pour tout le {formatShortDate(date)} ?{" "}
                  {many ? `Les ${fixedRows.length} équipages fixés` : "L'équipage fixé"}
                  {by} {many ? "seront oubliés" : "sera oublié"}.
                  {dirty.size > 0 ? " Vos modifications non enregistrées seront perdues." : ""} Un équipage qu&apos;un collègue a fixé
                  ou modifié depuis l&apos;affichage de la page est gardé.
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    refocusReset.current = true;
                    setConfirmingReset(false);
                  }}
                >
                  Garder les équipages
                </Button>
                <IntentSubmit intent="reset" variant="danger" pendingLabel={PENDING_LABEL} autoFocus>
                  Oui, revenir aux propositions
                </IntentSubmit>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-3">
                <div className="mr-auto max-w-2xl space-y-1 text-xs text-slate-500">
                  {dirty.size > 0 ? (
                    <p className="text-sm font-medium text-amber-800">
                      {dirty.size > 1 ? `${dirty.size} modifications non enregistrées` : "1 modification non enregistrée"}
                      {fixedRows.length > 0 || rows.some(canFix)
                        ? " : enregistrez-les (ou rechargez la page pour les abandonner) avant « Revenir à la proposition » ou « Fixer cette proposition »."
                        : "."}
                    </p>
                  ) : (
                    <p>
                      Seules les lignes modifiées sont enregistrées et deviennent des équipages fixés : l&apos;optimisation les
                      utilise tels quels, et propose un remplaçant si une personne fixée devient absente. Les autres lignes restent
                      des propositions qui suivent les absences.
                    </p>
                  )}
                </div>
                {hasSavedCrews ? (
                  <Button ref={resetButton} variant="secondary" onClick={() => setConfirmingReset(true)}>
                    Revenir aux propositions (tout le jour)
                  </Button>
                ) : null}
                <IntentSubmit intent="save" pendingLabel={SAVING_LABEL} disabled={dirty.size === 0}>
                  {dirty.size === 0
                    ? "Aucune modification"
                    : `Enregistrer ${dirty.size > 1 ? `les ${dirty.size} modifications` : "la modification"}`}
                </IntentSubmit>
              </div>
            )}
          </div>
        </fieldset>
      </form>
    </div>
  );
}

/** Choices of a driver seat that are not a person. */
function driverSpecial(row: CrewRow): SearchSelectOption[] {
  return row.origin === "parked"
    ? [{ value: PARK_VALUE, label: "— Laissé au dépôt ce jour —" }]
    : [
        { value: "", label: "— Aucun chauffeur —" },
        { value: PARK_VALUE, label: "Laisser au dépôt ce jour", hint: "Le véhicule ne roule pas, sans chercher de remplaçant" },
      ];
}

/** The seats of a row as hidden fields: the crew shown, its version and the crew chosen (read by readCrewForm). */
function SeatInputs({ row, value }: { row: CrewRow; value: SeatValues | undefined }) {
  if (row.unavailable) return <input type="hidden" name={versionField(row.vehicleId)} value={row.savedVersion ?? ""} />;
  const parked = value?.driver === PARK_VALUE;
  return (
    <>
      <input type="hidden" name={versionField(row.vehicleId)} value={row.savedVersion ?? ""} />
      <input type="hidden" name={shownDriverField(row.vehicleId)} value={shownValue(row, "driver")} />
      <input type="hidden" name={driverField(row.vehicleId)} value={value?.driver ?? ""} />
      {row.type === "AMBULANCE" ? (
        <>
          <input type="hidden" name={shownCrewMateField(row.vehicleId)} value={shownValue(row, "crewMate")} />
          {/* Left at the depot: nobody on board, no crew mate sent. */}
          {parked ? null : <input type="hidden" name={crewMateField(row.vehicleId)} value={value?.mate ?? ""} />}
        </>
      ) : null}
    </>
  );
}

/** A submit button that shows its pending label only when it is the one that sent the form. */
function IntentSubmit({
  intent,
  pendingLabel,
  children,
  disabled,
  variant = "primary",
  autoFocus,
}: {
  intent: string;
  pendingLabel: string;
  children: ReactNode;
  disabled?: boolean;
  variant?: "primary" | "danger";
  autoFocus?: boolean;
}) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get("intent") === intent;
  return (
    <Button type="submit" name="intent" value={intent} variant={variant} disabled={pending || disabled} aria-busy={mine} autoFocus={autoFocus}>
      {mine ? pendingLabel : children}
    </Button>
  );
}

/** The depot's heading in the table: its seats and the free people of the depot, next to its rows. */
function DepotHeader({ summary }: { summary: DepotSummary }) {
  const free = summary.free;
  return (
    <GroupHeaderRow colSpan={COLUMNS}>
      <span className="font-semibold tracking-wide text-slate-700 uppercase">Dépôt {summary.depotName}</span>
      <span className="ml-2">
        {summary.filled}/{summary.seats} postes pourvus
        {summary.missing > 0 ? <span className="font-medium text-red-700"> · {summary.missing} manquant{summary.missing > 1 ? "s" : ""}</span> : null}
      </span>
      <span className="ml-2 text-slate-500">
        · {free.length === 0 ? "aucun libre" : `${free.length} libre${free.length > 1 ? "s" : ""} : `}
        {free.slice(0, 8).map((p, i) => (
          <span key={p.id}>
            {i > 0 ? ", " : null}
            <span className="text-slate-700">{p.name}</span> ({p.qualifications})
          </span>
        ))}
        {free.length > 8 ? `, et ${free.length - 8} autres` : null}
      </span>
    </GroupHeaderRow>
  );
}

/** Summary of every depot, pinned at the top of the screen; a tile shows (or stops showing) that depot only. */
function DepotStrip({
  summaries,
  selected,
  onSelect,
}: {
  summaries: DepotSummary[];
  selected: string | null;
  onSelect: (depotId: string | null) => void;
}) {
  if (summaries.length < 2) return null;
  return (
    <nav
      aria-label="Postes par dépôt"
      className="sticky top-below-banner z-20 -mx-1 bg-slate-50/95 px-1 py-2 backdrop-blur"
    >
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {summaries.map((s) => (
          <li key={s.depotId}>
            <button
              type="button"
              aria-pressed={selected === s.depotId}
              onClick={() => onSelect(selected === s.depotId ? null : s.depotId)}
              title={selected === s.depotId ? "Afficher tous les dépôts" : `Afficher le dépôt ${s.depotName} seulement`}
              className={cn(
                "w-full rounded-md border px-2.5 py-1.5 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
                selected === s.depotId ? "border-brand-400 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50",
              )}
            >
              <span className="block truncate text-sm font-semibold text-slate-900">{s.depotName}</span>
              <span className="tabular block text-slate-600">
                {s.filled}/{s.seats} postes
                {s.missing > 0 ? <span className="font-semibold text-red-700"> · {s.missing} manquant{s.missing > 1 ? "s" : ""}</span> : null}
              </span>
              <span className="tabular block text-slate-500">
                {s.free.length} libre{s.free.length > 1 ? "s" : ""}
                {s.unavailable > 0 ? ` · ${s.unavailable} indisponible${s.unavailable > 1 ? "s" : ""}` : ""}
                {s.parked > 0 ? ` · ${s.parked} au dépôt` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
