"use client";

import { useState, type ReactNode } from "react";
import { AddressLookup } from "@/components/address/address-fields";
import { formatCoordinate, type GeocodeSuggestion } from "@/components/address/address-utils";
import { Field, Input } from "@/components/ui/form";

/**
 * An address typed on a trip, in one field (free destination of a private
 * trip, one-off address of « Modifier la course »): the address, « Localiser
 * l'adresse », and its coordinates. Inputs named `${prefix}Address`,
 * `${prefix}Lat` and `${prefix}Lng`; coordinates left empty are found on save
 * (geocoder configured).
 */
export function PlaceFields({
  prefix,
  label,
  hint = "Numéro, rue, code postal et ville.",
  defaults,
  errors,
  geocoder,
  placeholder = "ex. 12 rue de Rome, 13001 Marseille",
}: {
  prefix: string;
  label: ReactNode;
  hint?: string;
  defaults: { address: string; lat: string; lng: string };
  errors: Record<string, string | undefined>;
  geocoder: boolean;
  placeholder?: string;
}) {
  const names = { address: `${prefix}Address`, lat: `${prefix}Lat`, lng: `${prefix}Lng` };
  const [address, setAddress] = useState(defaults.address);
  const [lat, setLat] = useState(defaults.lat);
  const [lng, setLng] = useState(defaults.lng);
  const [located, setLocated] = useState<string | null>(null);
  const choose = (suggestion: GeocodeSuggestion) => {
    setAddress(suggestion.label);
    setLat(formatCoordinate(suggestion.lat));
    setLng(formatCoordinate(suggestion.lng));
    setLocated(suggestion.label);
  };
  const invalid = (field: string) => (errors[field] ? true : undefined);

  return (
    <div className="space-y-4 rounded-md border border-dashed border-slate-300 p-3">
      <Field label={label} htmlFor={names.address} error={errors[names.address]} hint={hint}>
        <Input
          id={names.address}
          name={names.address}
          required
          maxLength={200}
          autoComplete="off"
          placeholder={placeholder}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          aria-invalid={invalid(names.address)}
        />
      </Field>
      {/* The same lookup as the patient and facility addresses; without it the server geocodes on save. */}
      <AddressLookup query={address} onChoose={choose} geocoderEnabled={geocoder} changed={located !== null && located !== address} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Latitude"
          htmlFor={names.lat}
          error={errors[names.lat]}
          hint={
            geocoder
              ? "Remplie par « Localiser l'adresse », ou laissée vide : l'adresse est localisée à l'enregistrement."
              : "Obligatoire (géocodage non configuré)."
          }
        >
          <Input
            id={names.lat}
            name={names.lat}
            inputMode="decimal"
            placeholder="43,2965"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            className="tabular"
            aria-invalid={invalid(names.lat)}
          />
        </Field>
        <Field label="Longitude" htmlFor={names.lng} error={errors[names.lng]}>
          <Input
            id={names.lng}
            name={names.lng}
            inputMode="decimal"
            placeholder="5,3698"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            className="tabular"
            aria-invalid={invalid(names.lng)}
          />
        </Field>
      </div>
    </div>
  );
}

/** A choice among a few options drawn as buttons (payer, direction, home or other address). */
export function RadioGroup({
  legend,
  name,
  value,
  onChange,
  options,
  error,
}: {
  legend: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: ReactNode }[];
  error?: string;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-slate-700">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 has-checked:border-brand-500 has-checked:bg-brand-50 has-focus-visible:outline-2 has-focus-visible:outline-brand-600"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="size-4 accent-brand-700"
            />
            {option.label}
          </label>
        ))}
      </div>
      {error ? <p className="text-xs font-medium text-red-600">{error}</p> : null}
    </fieldset>
  );
}
