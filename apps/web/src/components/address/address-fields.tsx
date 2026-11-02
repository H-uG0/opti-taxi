"use client";

import { useId, useState, useTransition, type ChangeEvent } from "react";
import { AlertTriangle, Check, LoaderCircle, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Fieldset, Input } from "@/components/ui/form";
import { formatPercent } from "@/lib/labels";
import { geocodeAddressAction } from "./actions";
import {
  buildGeocodeQuery,
  formatCoordinate,
  LOW_GEOCODE_SCORE,
  type AddressFieldErrors,
  type AddressFieldName,
  type AddressFormValues,
  type GeocodeOutcome,
  type GeocodeSuggestion,
} from "./address-utils";

type Notice = { tone: "info" | "warning" | "error"; text: string } | null;

const MANUAL_HINT = "Vous pouvez saisir la latitude et la longitude à la main (relevées sur une carte).";

/**
 * Street address, postal code, city and coordinates, with an optional
 * « Localiser l'adresse » lookup in the national address base. Inputs are
 * named address / postalCode / city / lat / lng for the enclosing form.
 */
export function AddressFields({
  defaultValues,
  errors,
  geocoderEnabled,
  legend = "Adresse",
}: {
  defaultValues: AddressFormValues;
  errors?: AddressFieldErrors;
  geocoderEnabled: boolean;
  legend?: string;
}) {
  const prefix = useId();
  const [values, setValues] = useState<AddressFormValues>(defaultValues);
  const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [locatedQuery, setLocatedQuery] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const id = (name: AddressFieldName) => `${prefix}-${name}`;
  const set = (name: AddressFieldName) => (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setValues((current) => ({ ...current, [name]: next }));
  };
  const invalid = (name: AddressFieldName) => (errors?.[name]?.length ? true : undefined);

  const query = buildGeocodeQuery(values);
  const addressChangedSinceLocate = locatedQuery !== null && locatedQuery !== query;

  function locate() {
    if (query.length < 3) {
      setSuggestions([]);
      setNotice({ tone: "error", text: "Saisissez d'abord l'adresse, le code postal ou la ville." });
      return;
    }
    setNotice(null);
    startTransition(async () => {
      let outcome: GeocodeOutcome;
      try {
        outcome = await geocodeAddressAction(query);
      } catch {
        outcome = { status: "error", message: "La recherche d'adresse a échoué." };
      }
      switch (outcome.status) {
        case "ok":
          setSuggestions(outcome.results);
          setNotice(
            outcome.results.length === 0
              ? { tone: "warning", text: `Aucune adresse trouvée. Vérifiez la saisie. ${MANUAL_HINT}` }
              : null,
          );
          break;
        case "disabled":
          setSuggestions([]);
          setNotice({ tone: "info", text: `Le géocodage n'est pas configuré sur ce poste. ${MANUAL_HINT}` });
          break;
        case "invalid":
          setSuggestions([]);
          setNotice({ tone: "error", text: outcome.message });
          break;
        case "error":
          setSuggestions([]);
          setNotice({ tone: "error", text: `${outcome.message} ${MANUAL_HINT}` });
          break;
      }
    });
  }

  function choose(suggestion: GeocodeSuggestion) {
    const next: AddressFormValues = {
      address: suggestion.address || values.address,
      postalCode: suggestion.postalCode || values.postalCode,
      city: suggestion.city || values.city,
      lat: formatCoordinate(suggestion.lat),
      lng: formatCoordinate(suggestion.lng),
    };
    setValues(next);
    setSuggestions([]);
    setLocatedQuery(buildGeocodeQuery(next));
    const score = formatPercent(suggestion.score);
    setNotice(
      suggestion.score < LOW_GEOCODE_SCORE
        ? {
            tone: "warning",
            text: `Correspondance faible (${score}) pour « ${suggestion.label} » : vérifiez l'adresse et les coordonnées avant d'enregistrer.`,
          }
        : { tone: "info", text: `Coordonnées reprises de « ${suggestion.label} » (confiance ${score}).` },
    );
  }

  return (
    <Fieldset legend={legend}>
      <Field label="Adresse (numéro et voie)" htmlFor={id("address")} error={errors?.address}>
        <Input
          id={id("address")}
          name="address"
          value={values.address}
          onChange={set("address")}
          autoComplete="off"
          maxLength={200}
          required
          aria-invalid={invalid("address")}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <Field label="Code postal" htmlFor={id("postalCode")} error={errors?.postalCode}>
          <Input
            id={id("postalCode")}
            name="postalCode"
            value={values.postalCode}
            onChange={set("postalCode")}
            inputMode="numeric"
            autoComplete="off"
            maxLength={5}
            required
            className="tabular"
            aria-invalid={invalid("postalCode")}
          />
        </Field>
        <Field label="Ville" htmlFor={id("city")} error={errors?.city}>
          <Input
            id={id("city")}
            name="city"
            value={values.city}
            onChange={set("city")}
            autoComplete="off"
            maxLength={100}
            required
            aria-invalid={invalid("city")}
          />
        </Field>
      </div>

      <div className="space-y-2">
        {geocoderEnabled ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" onClick={locate} disabled={pending} aria-busy={pending}>
              {pending ? (
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
              ) : (
                <MapPin aria-hidden className="size-4" />
              )}
              {pending ? "Recherche…" : "Localiser l'adresse"}
            </Button>
            <p className="text-xs text-slate-500">Seule l&apos;adresse est envoyée au service de géocodage.</p>
          </div>
        ) : (
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Géocodage non configuré sur ce poste. {MANUAL_HINT}
          </p>
        )}

        <div aria-live="polite" className="space-y-2">
          {notice ? <NoticeLine notice={notice} /> : null}
          {addressChangedSinceLocate ? (
            <NoticeLine
              notice={{
                tone: "warning",
                text: "L'adresse a changé depuis la localisation : relancez la recherche ou vérifiez les coordonnées.",
              }}
            />
          ) : null}
          {suggestions.length > 0 ? (
            <div className="rounded-md border border-slate-200">
              <p className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
                {suggestions.length === 1 ? "1 adresse trouvée" : `${suggestions.length} adresses trouvées`} — choisissez la bonne
              </p>
              <ul className="divide-y divide-slate-100">
                {suggestions.map((s, index) => (
                  <li key={`${s.label}-${index}`}>
                    <button
                      type="button"
                      onClick={() => choose(s)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-brand-50 focus-visible:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900">{s.label}</span>
                        <span className="tabular block text-xs text-slate-500">
                          {formatCoordinate(s.lat)}, {formatCoordinate(s.lng)}
                        </span>
                      </span>
                      <Badge tone={s.score < LOW_GEOCODE_SCORE ? "warning" : "success"} className="tabular shrink-0">
                        {s.score < LOW_GEOCODE_SCORE ? "À vérifier · " : ""}
                        {formatPercent(s.score)}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Latitude"
          htmlFor={id("lat")}
          error={errors?.lat}
          hint="Degrés décimaux, ex. 43,2965"
        >
          <Input
            id={id("lat")}
            name="lat"
            value={values.lat}
            onChange={set("lat")}
            inputMode="decimal"
            autoComplete="off"
            required
            className="tabular"
            aria-invalid={invalid("lat")}
          />
        </Field>
        <Field
          label="Longitude"
          htmlFor={id("lng")}
          error={errors?.lng}
          hint="Degrés décimaux, ex. 5,3698"
        >
          <Input
            id={id("lng")}
            name="lng"
            value={values.lng}
            onChange={set("lng")}
            inputMode="decimal"
            autoComplete="off"
            required
            className="tabular"
            aria-invalid={invalid("lng")}
          />
        </Field>
      </div>
    </Fieldset>
  );
}

function NoticeLine({ notice }: { notice: NonNullable<Notice> }) {
  const styles = {
    info: "border-sky-200 bg-sky-50 text-sky-800",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-800",
  } as const;
  const Icon = notice.tone === "info" ? Check : AlertTriangle;
  return (
    <p className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${styles[notice.tone]}`}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{notice.text}</span>
    </p>
  );
}
