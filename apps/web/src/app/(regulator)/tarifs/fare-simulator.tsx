"use client";

import { useState } from "react";
import { Checkbox, Field, Select } from "@/components/ui/form";
import { DEFAULT_FARE_RULES, fareEuros, rideMinutes, sameRide, type FareCalendar, type FareGrid } from "@/lib/domain/fare";
import { formatEuros, formatPercent } from "@/lib/labels";
import { parseDecimal } from "@/lib/forms";
import { UnitInput } from "../vehicules/_lib/ui";

export type SimulatorGrid = FareGrid & { id: string; name: string };

const kmFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const NO_HOLIDAY = new Set<string>();

/** When the ride starts: a day of November 2026 and a pickup minute. */
const MOMENTS = {
  weekday: { label: "Semaine, de jour (mardi 10:00)", calendar: { date: "2026-11-10", holidays: NO_HOLIDAY }, pickupMin: 600 },
  night: { label: "Nuit (mardi 21:30)", calendar: { date: "2026-11-10", holidays: NO_HOLIDAY }, pickupMin: 1290 },
  saturday: { label: "Samedi après-midi (14:00)", calendar: { date: "2026-11-14", holidays: NO_HOLIDAY }, pickupMin: 840 },
  holiday: { label: "Dimanche ou jour férié, de jour", calendar: { date: "2026-11-15", holidays: NO_HOLIDAY }, pickupMin: 600 },
} satisfies Record<string, { label: string; calendar: FareCalendar; pickupMin: number }>;

type Moment = keyof typeof MOMENTS;

/** Example fare for N km, alone and shared, with one of the grids. */
export function FareSimulator({ grids, defaultGridId }: { grids: SimulatorGrid[]; defaultGridId: string | null }) {
  const [gridId, setGridId] = useState(defaultGridId ?? grids[0]?.id ?? "");
  const [kmText, setKmText] = useState("25");
  const [moment, setMoment] = useState<Moment>("weekday");
  const [bigCity, setBigCity] = useState(false);
  const [agglomeration, setAgglomeration] = useState(false);
  const [emptyLeg, setEmptyLeg] = useState(false);

  const grid = grids.find((g) => g.id === gridId);
  const parsedKm = parseDecimal(kmText);
  const km = parsedKm !== undefined && Number.isFinite(parsedKm) && parsedKm >= 0 && parsedKm <= 1000 ? parsedKm : null;

  if (grids.length === 0) {
    return <p className="text-sm text-slate-500">Créez une grille pour simuler un tarif.</p>;
  }

  const when = MOMENTS[moment];
  const trip = {
    bigCity: bigCity && (grid?.bigCityFare ?? 0) > 0,
    agglomeration: agglomeration && grid?.aggloFare != null,
    hospitalLinked: emptyLeg,
    wheelchair: false,
    tollAmount: 0,
  };
  const perPatient = (patients: number) =>
    grid && km !== null
      ? fareEuros(
          grid,
          trip,
          { tpmrEquipped: false },
          { ...sameRide(km, patients, when.pickupMin, rideMinutes(km)), emptyLeg: emptyLeg && patients === 1 },
          DEFAULT_FARE_RULES,
          when.calendar,
        )
      : 0;
  const counts = grid ? Array.from({ length: Math.min(grid.maxSharedPatients, 4) }, (_, i) => i + 1) : [];
  const solo = perPatient(1);
  const two = grid && grid.maxSharedPatients >= 2 ? perPatient(2) * 2 : null;

  return (
    <div className="space-y-4">
      <Field label="Grille" htmlFor="simulator-grid">
        <Select id="simulator-grid" value={gridId} onChange={(e) => setGridId(e.target.value)}>
          {grids.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Distance par patient" htmlFor="simulator-km" error={km === null ? "Distance entre 0 et 1 000 km." : null}>
          <UnitInput
            id="simulator-km"
            inputMode="decimal"
            autoComplete="off"
            unit="km"
            value={kmText}
            onChange={(e) => setKmText(e.target.value)}
            aria-invalid={km === null}
          />
        </Field>
        <Field label="Moment" htmlFor="simulator-moment">
          <Select id="simulator-moment" value={moment} onChange={(e) => setMoment(e.target.value as Moment)}>
            {Object.entries(MOMENTS).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {grid && (grid.bigCityFare > 0 || grid.aggloFare !== null || grid.emptyLegRateShort > 0 || grid.emptyLegRateLong > 0) ? (
        <div className="space-y-1.5">
          {grid.bigCityFare > 0 ? (
            <Checkbox checked={bigCity} onChange={(e) => setBigCity(e.target.checked)} label={`Grande ville (+${formatEuros(grid.bigCityFare)})`} />
          ) : null}
          {grid.aggloFare !== null ? (
            <Checkbox checked={agglomeration} onChange={(e) => setAgglomeration(e.target.checked)} label="Dans l'agglomération du siège" />
          ) : null}
          {grid.emptyLegRateShort > 0 || grid.emptyLegRateLong > 0 ? (
            <Checkbox checked={emptyLeg} onChange={(e) => setEmptyLeg(e.target.checked)} label="Hospitalisation avec retour à vide (patient seul)" />
          ) : null}
        </div>
      ) : null}

      {grid && km !== null ? (
        <div className="space-y-3" aria-live="polite">
          <table className="tabular w-full text-sm">
            <caption className="sr-only">Tarif estimé pour {kmFormat.format(km)} km</caption>
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th scope="col" className="py-1.5 text-left font-medium">
                  Course
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  Par patient
                </th>
                <th scope="col" className="py-1.5 text-right font-medium">
                  Véhicule
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {counts.map((patients) => {
                const fare = perPatient(patients);
                const rate = grid.sharedDiscounts.filter((d) => d.patients <= patients).at(-1)?.rate ?? 0;
                return (
                  <tr key={patients} className={patients === 2 ? "bg-brand-50/60" : undefined}>
                    <th scope="row" className="py-1.5 text-left font-normal">
                      {patients === 1 ? "Seul" : `Partagé à ${patients}${patients === 4 && grid.maxSharedPatients > 4 ? " et plus" : ""}`}
                      {patients > 1 ? <span className="block text-xs text-slate-500">abattement {formatPercent(rate, 1)}</span> : null}
                    </th>
                    <td className="py-1.5 text-right">{formatEuros(fare)}</td>
                    <td className="py-1.5 text-right font-medium">{formatEuros(fare * patients)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {two !== null && solo > 0 ? (
            <p className="text-xs leading-relaxed text-slate-600">
              À 2 patients, le véhicule facture{" "}
              <strong className="tabular font-semibold text-slate-900">
                {two >= solo ? "+" : ""}
                {formatPercent(two / solo - 1)}
              </strong>{" "}
              par rapport à un trajet seul, sans compter les kilomètres et le temps chauffeur économisés. Hypothèse : chaque patient
              parcourt {kmFormat.format(km)} km, sans détour.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
