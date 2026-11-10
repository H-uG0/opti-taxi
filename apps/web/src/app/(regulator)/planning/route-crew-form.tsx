"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import type { VehicleRowView } from "@/lib/planning/types";
import { choiceDepotText, choiceProblem, pairProblem, rankChoices, type CrewChoice } from "@/lib/staff/route-crew";
import { shiftText, type CrewRules, type Seat } from "@/lib/staff/day-crews";
import { changeRouteCrew } from "./actions";
import { usePlanningActivity } from "./planning-activity";

/** Where the crew of a vehicle changes on this day. */
export type CrewChangeMode =
  /** Validated or started day: « Changer l'équipage » on the route itself. */
  | "route"
  /** Proposed day: on the Équipages page, then re-optimize. */
  | "equipages"
  /** Past date: no change. */
  | "none";

const SEAT_NOUN: Record<Seat, string> = { driver: "chauffeur", crewMate: "équipier" };

function optionText(choice: CrewChoice, seat: Seat, vehicle: VehicleRowView, current: string | null, problem: string | null): string {
  const notes: string[] = [];
  if (choice.id === current) notes.push("actuel");
  if (problem) notes.push(problem);
  else {
    if (vehicle.type === "AMBULANCE" && choice.completesAmbulance) notes.push("DE");
    if (!choice.worksThatDay) notes.push("hors de ses jours habituels");
    notes.push(shiftText(choice.shift));
  }
  // Same wording as the automatic proposals: a person of another depot may be far from this vehicle.
  const depot = choiceDepotText(choice, vehicle.depot);
  if (depot) notes.push(depot);
  return `${choice.name} (${notes.join(", ")})`;
}

function SeatSelect({
  seat,
  vehicle,
  choices,
  value,
  current,
  other,
  error,
  onChange,
  disabled,
}: {
  seat: Seat;
  vehicle: VehicleRowView;
  /** Ranked for the vehicle (rankChoices). */
  choices: CrewChoice[];
  value: string;
  current: string | null;
  /** Person chosen on the other seat: not offered here. */
  other: string;
  error: string | undefined;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const errorId = useId();
  const remaining = vehicle.route?.remaining ?? null;
  const otherSeat = SEAT_NOUN[seat === "driver" ? "crewMate" : "driver"];
  const chosenThere = `choisi comme ${otherSeat}`;
  const problems = new Map(choices.map((c) => [c.id, choiceProblem(c, seat, vehicle, remaining)]));
  // The person chosen on the other seat: still selectable when they could take this seat (to swap the two
  // seats), never offered as available.
  const onOtherSeat = other === "" ? undefined : choices.find((c) => c.id === other && problems.get(c.id) === null);
  if (other !== "" && !onOtherSeat) {
    const problem = problems.get(other);
    if (problem) problems.set(other, `${problem}, ${chosenThere}`);
  }
  // The current member who can no longer take the seat (absent…): still the value shown, never offered as available.
  const currentUnavailable = choices.find((c) => c.id === current && c !== onOtherSeat && problems.get(c.id) !== null);
  const possible = choices.filter((c) => c !== onOtherSeat && problems.get(c.id) === null);
  const others = choices.filter((c) => c !== onOtherSeat && c !== currentUnavailable && problems.get(c.id) !== null);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-slate-700">
        {seat === "driver" ? "Chauffeur" : "Équipier"}
      </label>
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        disabled={disabled}
        className="w-full"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
      >
        <option value="" disabled>
          — Choisir —
        </option>
        {onOtherSeat ? (
          <optgroup label={`Choisi comme ${otherSeat}`}>
            <option value={onOtherSeat.id}>{optionText(onOtherSeat, seat, vehicle, current, chosenThere)}</option>
          </optgroup>
        ) : null}
        {currentUnavailable ? (
          <optgroup label="Actuel (indisponible)">
            <option value={currentUnavailable.id}>
              {optionText(currentUnavailable, seat, vehicle, current, problems.get(currentUnavailable.id) ?? null)}
            </option>
          </optgroup>
        ) : null}
        {possible.length > 0 ? (
          <optgroup label="Disponibles">
            {possible.map((c) => (
              <option key={c.id} value={c.id}>
                {optionText(c, seat, vehicle, current, null)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {others.length > 0 ? (
          <optgroup label="Indisponibles ce jour pour ce poste">
            {others.map((c) => (
              <option key={c.id} value={c.id} disabled>
                {optionText(c, seat, vehicle, current, problems.get(c.id) ?? null)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
      {error ? (
        <p id={errorId} className="text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * « Changer l'équipage » of the selected vehicle's route (vehicle panel). On a
 * validated or started day the route keeps its stops: only its driver and
 * crew mate change, and the roadmap follows them at once. On a proposed day
 * the crews change on the Équipages page, then the day is re-optimized.
 */
export function RouteCrewChange({
  date,
  vehicle,
  choices,
  rules,
  version,
  mode,
  blocked,
}: {
  date: string;
  vehicle: VehicleRowView;
  choices: CrewChoice[];
  /** Shared working time an ambulance pair needs (Paramètres). */
  rules: Pick<CrewRules, "minPairOverlapMin">;
  /** Plan version shown (a change on a stale page is refused). */
  version: string;
  mode: CrewChangeMode;
  /** Why the change is not possible right now (a computation running), or null. */
  blocked: string | null;
}) {
  const { busy, run } = usePlanningActivity();
  const route = vehicle.route;
  const [open, setOpen] = useState(false);
  const [driverId, setDriverId] = useState(route?.driverId ?? "");
  const [crewMateId, setCrewMateId] = useState(route?.crewMateId ?? "");
  /** Refusal of the last submission, by seat or for the whole form: shown here, not in the banner far above. */
  const [refusal, setRefusal] = useState<Partial<Record<string, string>>>({});
  const ranked = useMemo(() => rankChoices(choices, vehicle.depot), [choices, vehicle.depot]);
  if (!route || mode === "none") return null;

  if (mode === "equipages") {
    return (
      <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-600">
        Planning proposé&nbsp;: l&apos;équipage se change sur la page{" "}
        <Link href={`/equipages?date=${date}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">
          Équipages
        </Link>
        , puis réoptimisez.
      </p>
    );
  }

  const finished = route.remaining === null;
  const reason = finished ? "Tournée terminée\u00a0: son équipage ne se change plus." : blocked;
  const ambulance = vehicle.type === "AMBULANCE";
  const unchanged = driverId === (route.driverId ?? "") && (!ambulance || crewMateId === (route.crewMateId ?? ""));
  const incomplete = driverId === "" || (ambulance && crewMateId === "");
  // The pair rules the server applies too (no DEA, shared working time): said before submitting.
  const chosen = (id: string) => (id === "" ? undefined : choices.find((c) => c.id === id));
  const driver = chosen(driverId);
  const mate = ambulance ? chosen(crewMateId) : undefined;
  const samePerson = ambulance && driverId !== "" && driverId === crewMateId;
  const pairWarning = samePerson
    ? "Le chauffeur et l'équipier doivent être deux personnes différentes."
    : driver && mate && !unchanged
      ? pairProblem(driver, mate, vehicle.type, rules)
      : null;
  const choose = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setRefusal({});
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-slate-600">
          {reason ?? "Remplacer le chauffeur ou l'équipier de cette tournée sans réoptimiser la journée."}
        </p>
        <Button size="sm" variant="secondary" disabled={busy || reason !== null} onClick={() => setOpen(true)}>
          <UserRoundCog aria-hidden className="size-3.5" />
          Changer l&apos;équipage
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-2.5 border-t border-slate-100 bg-slate-50/60 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (unchanged || incomplete || pairWarning) return;
        setRefusal({});
        run(`Changement de l'équipage de ${vehicle.label}…`, () => changeRouteCrew(route.id, driverId, ambulance ? crewMateId : "", version), {
          onResult: (result) => {
            if (result.ok) setOpen(false);
            else setRefusal(result.fieldErrors ?? { form: result.error });
          },
        });
      }}
    >
      <p className="text-sm font-medium text-slate-900">Changer l&apos;équipage de la tournée</p>
      <SeatSelect
        seat="driver"
        vehicle={vehicle}
        choices={ranked}
        value={driverId}
        current={route.driverId}
        other={ambulance ? crewMateId : ""}
        error={refusal.driver}
        onChange={choose(setDriverId)}
        disabled={busy}
      />
      {ambulance ? (
        <SeatSelect
          seat="crewMate"
          vehicle={vehicle}
          choices={ranked}
          value={crewMateId}
          current={route.crewMateId}
          other={driverId}
          error={refusal.crewMate ?? pairWarning ?? undefined}
          onChange={choose(setCrewMateId)}
          disabled={busy}
        />
      ) : null}
      <p className="text-xs text-slate-500">
        {route.remaining ? `Suite de la tournée\u00a0: ${shiftText(route.remaining)}. ` : ""}
        Les arrêts et les horaires ne changent pas. La tournée apparaît aussitôt sur la feuille de route du remplaçant (s&apos;il
        a un compte actif) et disparaît de celle de la personne remplacée.
        {ambulance ? " Une ambulance part avec au moins un ambulancier DE, au volant ou auprès du patient." : ""}
      </p>
      {refusal.form ? (
        <p role="alert" className="text-xs font-medium text-red-700">
          {refusal.form}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setDriverId(route.driverId ?? "");
            setCrewMateId(route.crewMateId ?? "");
            setRefusal({});
          }}
        >
          Annuler
        </Button>
        <Button size="sm" type="submit" disabled={busy || unchanged || incomplete || pairWarning !== null}>
          Enregistrer l&apos;équipage
        </Button>
      </div>
    </form>
  );
}
