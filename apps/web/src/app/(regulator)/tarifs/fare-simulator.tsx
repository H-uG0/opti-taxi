"use client";

import { useState } from "react";
import { Field, Select } from "@/components/ui/form";
import { formatEuros, formatPercent } from "@/lib/labels";
import { parseDecimal } from "@/lib/forms";
import { UnitInput } from "../vehicules/_lib/ui";
import { sharedComparison, soloFare, type FareGrid } from "./fare";

export type SimulatorGrid = FareGrid & { id: string; name: string };

const kmFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

/** Example fare for N km, solo vs shared, with one of the grids. */
export function FareSimulator({ grids, defaultGridId }: { grids: SimulatorGrid[]; defaultGridId: string | null }) {
  const [gridId, setGridId] = useState(defaultGridId ?? grids[0]?.id ?? "");
  const [kmText, setKmText] = useState("25");

  const grid = grids.find((g) => g.id === gridId);
  const parsedKm = parseDecimal(kmText);
  const km = parsedKm !== undefined && Number.isFinite(parsedKm) && parsedKm >= 0 && parsedKm <= 2000 ? parsedKm : null;

  if (grids.length === 0) {
    return <p className="text-sm text-slate-500">Créez une grille pour simuler un tarif.</p>;
  }

  const two = grid && km !== null ? sharedComparison(grid, km, 2) : null;
  const three = grid && km !== null ? sharedComparison(grid, km, 3) : null;

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
      <Field label="Distance par patient (km)" htmlFor="simulator-km" error={km === null ? "Distance entre 0 et 2 000 km." : null}>
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

      {grid && km !== null && two && three ? (
        <div className="space-y-3" aria-live="polite">
          <p className="tabular text-xs text-slate-500">
            {formatEuros(grid.baseFare)} + {formatEuros(grid.pricePerKm)}/km × {kmFormat.format(Math.max(0, km - grid.includedKm))} km
            {grid.includedKm > 0 ? ` (${kmFormat.format(grid.includedKm)} km inclus)` : ""} ={" "}
            <span className="font-medium text-slate-700">{formatEuros(soloFare(grid, km))}</span>
          </p>
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
              <tr>
                <th scope="row" className="py-1.5 text-left font-normal">
                  Seul
                </th>
                <td className="py-1.5 text-right">{formatEuros(two.solo)}</td>
                <td className="py-1.5 text-right font-medium">{formatEuros(two.solo)}</td>
              </tr>
              <tr className="bg-brand-50/60">
                <th scope="row" className="py-1.5 text-left font-medium">
                  Partagé à 2
                  <span className="block text-xs font-normal text-slate-500">
                    abattement {formatPercent(grid.sharedDiscount2, 1)}
                  </span>
                </th>
                <td className="py-1.5 text-right">{formatEuros(two.perPatient)}</td>
                <td className="py-1.5 text-right font-semibold">{formatEuros(two.vehicleTotal)}</td>
              </tr>
              <tr className="text-slate-500">
                <th scope="row" className="py-1.5 text-left font-normal">
                  Partagé à 3
                  <span className="block text-xs">abattement {formatPercent(grid.sharedDiscount3, 1)}</span>
                </th>
                <td className="py-1.5 text-right">{formatEuros(three.perPatient)}</td>
                <td className="py-1.5 text-right">{formatEuros(three.vehicleTotal)}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-xs leading-relaxed text-slate-600">
            À 2 patients, chacun paie {formatPercent(grid.sharedDiscount2, 1)} de moins, mais le véhicule facture{" "}
            <strong className="tabular font-semibold text-slate-900">
              {two.gainVsSolo >= 0 ? "+" : ""}
              {formatPercent(two.gainVsSolo)}
            </strong>{" "}
            par rapport à un trajet seul — sans compter les kilomètres et le temps chauffeur économisés. Hypothèse :
            chaque patient parcourt {kmFormat.format(km)} km.
          </p>
        </div>
      ) : null}
    </div>
  );
}
