"use client";

/**
 * « Ajouter un plein ou une recharge » for the day's vehicle (FLD-03): the odometer, the quantity (L, or kWh for an
 * electric vehicle), the amount, full tank or not; dated on the route's day. Sent at once (POST
 * /api/chauffeur/routes/:id/fuel) with the regulator's checks; online only: without network nothing leaves, and the
 * form says so (the receipt can be handed to the regulation).
 */
import { useId, useState, type FormEvent } from "react";
import { Fuel, PlugZap } from "lucide-react";
import type { EnergyType } from "@prisma/client";
import { cn } from "@/components/ui/cn";
import type { FuelResponse } from "@/app/api/chauffeur/routes/[id]/fuel/route";
import { energyUnit } from "@/lib/fleet/consumption";
import { fuelUrl } from "../_lib/status-protocol";
import { useDriverApp } from "./driver-app";

const field = "tabular min-h-12 w-full rounded-xl border border-field bg-white px-3 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600";

type Fields = "odometerKm" | "quantity" | "cost";

export function FuelForm({ routeId, energy, odometerHint }: { routeId: string; energy: EnergyType | null; odometerHint: number | null }) {
  const { ownerId } = useDriverApp();
  const unit = energyUnit(energy);
  const electric = unit === "kWh";
  const [values, setValues] = useState<Record<Fields, string>>({ odometerKm: odometerHint !== null ? String(odometerHint) : "", quantity: "", cost: "" });
  const [fullTank, setFullTank] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({});
  const id = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      if (navigator.onLine === false) throw new Error("offline");
      const response = await fetch(fuelUrl(routeId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, fullTank, ownerId }),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      const answer = (await response.json().catch(() => null)) as FuelResponse | null;
      if (!answer) throw new Error("unreadable");
      if (answer.ok) {
        setMessage({ ok: true, text: answer.message });
        setValues({ odometerKm: "", quantity: "", cost: "" });
      } else {
        setMessage({ ok: false, text: answer.error });
        setErrors(answer.fieldErrors ?? {});
      }
    } catch {
      setMessage({ ok: false, text: "Pas de réseau : rien n'a été envoyé. Réessayez plus tard, ou donnez le ticket à la régulation." });
    } finally {
      setBusy(false);
    }
  };

  const input = (name: Fields, label: string, suffix: string, mode: "numeric" | "decimal") => (
    <div>
      <label htmlFor={`${id}-${name}`} className="text-sm font-medium text-slate-800">
        {label} ({suffix})
      </label>
      <input
        id={`${id}-${name}`}
        inputMode={mode}
        autoComplete="off"
        required
        value={values[name]}
        onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `${id}-${name}-error` : undefined}
        className={cn(field, "mt-1", errors[name] && "border-red-600")}
      />
      {errors[name] ? (
        <p id={`${id}-${name}-error`} className="mt-1 text-sm text-red-800">
          {errors[name]}
        </p>
      ) : null}
    </div>
  );

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="flex items-center gap-2 text-base font-semibold text-slate-950">
        {electric ? <PlugZap aria-hidden className="size-5 text-brand-700" /> : <Fuel aria-hidden className="size-5 text-brand-700" />}
        {electric ? "Ajouter une recharge" : "Ajouter un plein"}
      </p>
      {input("odometerKm", "Compteur", "km", "numeric")}
      <div className="grid grid-cols-2 gap-2">
        {input("quantity", "Quantité", unit, "decimal")}
        {input("cost", "Montant", "€", "decimal")}
      </div>
      <label className="flex min-h-11 items-center gap-3 text-base text-slate-900">
        <input type="checkbox" checked={fullTank} onChange={(e) => setFullTank(e.target.checked)} className="size-5 accent-brand-700" />
        {electric ? "Charge complète" : "Plein complet"}
      </label>
      {message ? (
        <p role="status" className={cn("rounded-lg px-3 py-2 text-sm font-medium", message.ok ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900")}>
          {message.text}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="inline-flex min-h-12 w-full touch-manipulation items-center justify-center rounded-xl bg-brand-700 px-4 text-base font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
      >
        {busy ? "Envoi…" : electric ? "Enregistrer la recharge" : "Enregistrer le plein"}
      </button>
    </form>
  );
}
