"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import type { VehicleRowView } from "@/lib/planning/types";
import { choiceProblem, type CrewChoice } from "@/lib/staff/route-crew";
import { shiftText, type Seat } from "@/lib/staff/day-crews";
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

function optionText(choice: CrewChoice, seat: Seat, vehicle: VehicleRowView, current: string | null): string {
  const notes: string[] = [];
  const problem = choiceProblem(choice, seat, vehicle, vehicle.route?.remaining ?? null);
  if (choice.id === current) notes.push("actuel");
  if (problem) notes.push(problem);
  else {
    if (vehicle.type === "AMBULANCE" && choice.completesAmbulance) notes.push("DE");
    if (!choice.worksThatDay) notes.push("hors de ses jours habituels");
    notes.push(shiftText(choice.shift));
  }
  return `${choice.name} (${notes.join(", ")})`;
}

function SeatSelect({
  seat,
  vehicle,
  choices,
  value,
  current,
  onChange,
  disabled,
}: {
  seat: Seat;
  vehicle: VehicleRowView;
  choices: CrewChoice[];
  value: string;
  current: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const remaining = vehicle.route?.remaining ?? null;
  const possible = choices.filter((c) => c.id === current || choiceProblem(c, seat, vehicle, remaining) === null);
  const others = choices.filter((c) => !possible.includes(c));
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-slate-700">
        {seat === "driver" ? "Chauffeur" : "Équipier"}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)} disabled={disabled} className="w-full">
        <option value="" disabled>
          — Choisir —
        </option>
        <optgroup label="Disponibles">
          {possible.map((c) => (
            <option key={c.id} value={c.id}>
              {optionText(c, seat, vehicle, current)}
            </option>
          ))}
        </optgroup>
        {others.length > 0 ? (
          <optgroup label="Indisponibles ce jour pour ce poste">
            {others.map((c) => (
              <option key={c.id} value={c.id} disabled>
                {optionText(c, seat, vehicle, current)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
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
  version,
  mode,
  blocked,
}: {
  date: string;
  vehicle: VehicleRowView;
  choices: CrewChoice[];
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
  if (!route || mode === "none") return null;

  if (mode === "equipages") {
    return (
      <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-600">
        Planning proposé : l&apos;équipage se change sur la page{" "}
        <Link href={`/equipages?date=${date}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">
          Équipages
        </Link>
        , puis réoptimisez.
      </p>
    );
  }

  const finished = route.remaining === null;
  const reason = finished ? "Tournée terminée : son équipage ne se change plus." : blocked;
  const ambulance = vehicle.type === "AMBULANCE";
  const unchanged = driverId === (route.driverId ?? "") && (!ambulance || crewMateId === (route.crewMateId ?? ""));
  const incomplete = driverId === "" || (ambulance && crewMateId === "");

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
        if (unchanged || incomplete) return;
        run(`Changement de l'équipage de ${vehicle.label}…`, () => changeRouteCrew(route.id, driverId, ambulance ? crewMateId : "", version), {
          onResult: (result) => {
            if (result.ok) setOpen(false);
          },
        });
      }}
    >
      <p className="text-sm font-medium text-slate-900">Changer l&apos;équipage de la tournée</p>
      <SeatSelect
        seat="driver"
        vehicle={vehicle}
        choices={choices}
        value={driverId}
        current={route.driverId}
        onChange={setDriverId}
        disabled={busy}
      />
      {ambulance ? (
        <SeatSelect
          seat="crewMate"
          vehicle={vehicle}
          choices={choices}
          value={crewMateId}
          current={route.crewMateId}
          onChange={setCrewMateId}
          disabled={busy}
        />
      ) : null}
      <p className="text-xs text-slate-500">
        {route.remaining ? `Suite de la tournée : ${shiftText(route.remaining)}. ` : ""}
        Les arrêts et les horaires ne changent pas. La tournée apparaît aussitôt sur la feuille de route du remplaçant et
        disparaît de celle de la personne remplacée.
        {ambulance ? " Une ambulance part avec au moins un ambulancier DE, au volant ou auprès du patient." : ""}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setDriverId(route.driverId ?? "");
            setCrewMateId(route.crewMateId ?? "");
          }}
        >
          Annuler
        </Button>
        <Button size="sm" type="submit" disabled={busy || unchanged || incomplete}>
          Enregistrer l&apos;équipage
        </Button>
      </div>
    </form>
  );
}
