"use client";

import { useActionState, useState, type ClipboardEvent } from "react";
import { ExternalLink } from "lucide-react";
import { Field, Fieldset, FormMessage, Input, Textarea } from "@/components/ui/form";
import { IDLE_STATE, parseDecimal, valueOf, type FieldErrors, type FormState, type FormValues } from "@/lib/forms";
import { FormFooter, InlineWarning } from "@/app/(regulator)/vehicules/_lib/ui";
import { isInFrance, parseCoordinatePair } from "./schema";

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

export function DepotForm({ action, initial, submitLabel }: { action: Action; initial: FormValues; submitLabel: string }) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;

  return (
    // Remount on every response so uncontrolled inputs show the echoed values.
    <form key={state.submissionId} action={formAction} className="space-y-6">
      {state.status === "error" && state.message ? <FormMessage>{state.message}</FormMessage> : null}
      {state.status === "success" && state.message ? <FormMessage tone="success">{state.message}</FormMessage> : null}
      <DepotFields values={values} errors={state.fieldErrors} />
      <FormFooter cancelHref="/depots" submitLabel={submitLabel} />
    </form>
  );
}

function DepotFields({ values, errors }: { values: FormValues; errors: FieldErrors }) {
  const [lat, setLat] = useState(valueOf(values, "lat"));
  const [lng, setLng] = useState(valueOf(values, "lng"));

  /** Pasting "43.2965, 5.3698" from a map fills both coordinates. */
  function pasteCoordinates(event: ClipboardEvent<HTMLInputElement>) {
    const pair = parseCoordinatePair(event.clipboardData.getData("text"));
    if (!pair) return;
    event.preventDefault();
    setLat(pair.lat);
    setLng(pair.lng);
  }

  const latNumber = parseDecimal(lat);
  const lngNumber = parseDecimal(lng);
  const hasCoordinates =
    latNumber !== undefined && lngNumber !== undefined && Number.isFinite(latNumber) && Number.isFinite(lngNumber);
  const coordinatesInFrance = hasCoordinates && isInFrance(latNumber, lngNumber);

  return (
    <>
      <Fieldset legend="Dépôt">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Nom du dépôt" htmlFor="name" hint="Ex. « Sisteron »." error={errors.name} className="lg:col-span-2">
            <Input
              id="name"
              name="name"
              required
              maxLength={60}
              defaultValue={valueOf(values, "name")}
              aria-invalid={Boolean(errors.name)}
            />
          </Field>
          <Field
            label="Adresse"
            htmlFor="address"
            hint="Point de départ et de retour des tournées de ses véhicules."
            error={errors.address}
            className="sm:col-span-2 lg:col-span-4"
          >
            <Input
              id="address"
              name="address"
              required
              maxLength={200}
              autoComplete="street-address"
              defaultValue={valueOf(values, "address")}
              aria-invalid={Boolean(errors.address)}
            />
          </Field>
          <Field label="Latitude" htmlFor="lat" error={errors.lat}>
            <Input
              id="lat"
              name="lat"
              required
              inputMode="decimal"
              autoComplete="off"
              placeholder="43.2965"
              className="tabular"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              onPaste={pasteCoordinates}
              aria-invalid={Boolean(errors.lat)}
              aria-describedby="coordinates-hint"
            />
          </Field>
          <Field label="Longitude" htmlFor="lng" error={errors.lng}>
            <Input
              id="lng"
              name="lng"
              required
              inputMode="decimal"
              autoComplete="off"
              placeholder="5.3698"
              className="tabular"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              onPaste={pasteCoordinates}
              aria-invalid={Boolean(errors.lng)}
              aria-describedby="coordinates-hint"
            />
          </Field>
          <div id="coordinates-hint" className="space-y-1 text-xs text-slate-500 sm:col-span-2 lg:self-end">
            <p>
              Coordonnées en degrés décimaux. Dans OpenStreetMap ou Google Maps, un clic droit sur le dépôt affiche
              « 43.2965, 5.3698 » : collez ce texte dans l&apos;un des deux champs, ils seront remplis ensemble.
            </p>
            {hasCoordinates && !coordinatesInFrance ? (
              <p>
                <InlineWarning>Hors de France métropolitaine : latitude et longitude inversées ?</InlineWarning>
              </p>
            ) : null}
            {coordinatesInFrance ? (
              <p>
                <a
                  href={`https://www.openstreetmap.org/?mlat=${latNumber}&mlon=${lngNumber}#map=17/${latNumber}/${lngNumber}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  Vérifier le point sur OpenStreetMap
                  <ExternalLink aria-hidden className="size-3" />
                  <span className="sr-only">(nouvel onglet)</span>
                </a>
              </p>
            ) : null}
          </div>
          <Field
            label="Notes"
            htmlFor="notes"
            hint="Facultatif : accès, parking, horaires d'ouverture…"
            error={errors.notes}
            className="sm:col-span-2 lg:col-span-4"
          >
            <Textarea
              id="notes"
              name="notes"
              rows={2}
              maxLength={500}
              defaultValue={valueOf(values, "notes")}
              aria-invalid={Boolean(errors.notes)}
            />
          </Field>
        </div>
      </Fieldset>
    </>
  );
}
