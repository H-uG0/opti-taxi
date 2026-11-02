"use client";

import { useActionState, useState, type ClipboardEvent, type ReactNode } from "react";
import type { Qualification, VehicleType } from "@prisma/client";
import { ExternalLink } from "lucide-react";
import { Field, Fieldset, FormMessage, Input, Select } from "@/components/ui/form";
import { DEFAULT_CAPACITY } from "@/lib/domain/rules";
import { VEHICLE_TYPE_LABELS } from "@/lib/labels";
import {
  crewMateRequirement,
  driverRequirement,
  hasRequiredQualification,
  qualificationRequirement,
  sharedCrewWarning,
  VEHICLE_TYPE_WITH_ARTICLE,
  type CrewSeat,
} from "./_lib/crew";
import { DEPARTMENT_NAMES } from "./_lib/departments";
import { IDLE_STATE, parseDecimal, valueOf, type FieldErrors, type FormState, type FormValues } from "@/lib/forms";
import { FormFooter, InlineWarning, UnitInput } from "./_lib/ui";
import { MAX_SHARED_CAPACITY, VEHICLE_TYPES, isInFrance, isVehicleType, parseCoordinatePair } from "./schema";

export type DriverOption = {
  id: string;
  name: string;
  qualifications: Qualification[];
  active: boolean;
  /** Other active vehicles this person is already in the default crew of. */
  seats: CrewSeat[];
};

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

export function VehicleForm({
  action,
  initial,
  drivers,
  submitLabel,
}: {
  action: Action;
  initial: FormValues;
  drivers: DriverOption[];
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, IDLE_STATE);
  const values = state.values ?? initial;

  return (
    // Remount on every response so uncontrolled inputs show the echoed values.
    <form key={state.submissionId} action={formAction} className="space-y-6">
      {state.status === "error" && state.message ? <FormMessage>{state.message}</FormMessage> : null}
      <VehicleFields values={values} errors={state.fieldErrors} drivers={drivers} />
      <FormFooter cancelHref="/vehicules" submitLabel={submitLabel} />
    </form>
  );
}

function VehicleFields({
  values,
  errors,
  drivers,
}: {
  values: FormValues;
  errors: FieldErrors;
  drivers: DriverOption[];
}) {
  const initialType = valueOf(values, "type");
  const [type, setType] = useState<VehicleType>(isVehicleType(initialType) ? initialType : "TAXI");
  const [capacity, setCapacity] = useState(() => valueOf(values, "capacity") || String(DEFAULT_CAPACITY.TAXI));
  const [driverId, setDriverId] = useState(valueOf(values, "defaultDriverId"));
  const [crewMateId, setCrewMateId] = useState(valueOf(values, "defaultCrewMateId"));
  const [lat, setLat] = useState(valueOf(values, "depotLat"));
  const [lng, setLng] = useState(valueOf(values, "depotLng"));

  function changeType(next: VehicleType) {
    if (next === "AMBULANCE") setCapacity("1");
    else if (type === "AMBULANCE") setCapacity(String(DEFAULT_CAPACITY[next]));
    setType(next);
  }

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

  const driverRule = driverRequirement(type);
  const crewRule = crewMateRequirement(type);
  const selectedDriver = drivers.find((d) => d.id === driverId);
  const selectedCrewMate = drivers.find((d) => d.id === crewMateId);
  const isAmbulance = type === "AMBULANCE";

  // Most important message first: a missing qualification blocks the save,
  // a person shared with another vehicle only warns.
  const driverRequired = `Requis pour conduire ${VEHICLE_TYPE_WITH_ARTICLE[type]} : ${qualificationRequirement(driverRule)}.`;
  const driverShared = selectedDriver ? sharedCrewWarning(selectedDriver.name, selectedDriver.seats) : null;
  let driverHint: ReactNode = driverRequired;
  if (selectedDriver && !hasRequiredQualification(selectedDriver.qualifications, driverRule)) {
    driverHint = (
      <InlineWarning>
        {selectedDriver.name} n&apos;a pas la qualification requise ({qualificationRequirement(driverRule)}) :
        l&apos;enregistrement sera refusé.
      </InlineWarning>
    );
  } else if (driverShared) {
    driverHint = <InlineWarning>{driverShared}</InlineWarning>;
  } else if (driverId === "") {
    driverHint = `Sans chauffeur par défaut, le véhicule ne sera pas planifié. ${driverRequired}`;
  }

  let crewMateHint: ReactNode = null;
  if (isAmbulance && crewRule) {
    const crewMateShared = selectedCrewMate ? sharedCrewWarning(selectedCrewMate.name, selectedCrewMate.seats) : null;
    if (crewMateId && crewMateId === driverId) {
      crewMateHint = <InlineWarning>L&apos;équipier doit être une autre personne que le chauffeur.</InlineWarning>;
    } else if (selectedCrewMate && !hasRequiredQualification(selectedCrewMate.qualifications, crewRule)) {
      crewMateHint = (
        <InlineWarning>
          {selectedCrewMate.name} n&apos;a pas la qualification requise ({qualificationRequirement(crewRule)}) :
          l&apos;enregistrement sera refusé.
        </InlineWarning>
      );
    } else if (crewMateShared) {
      crewMateHint = <InlineWarning>{crewMateShared}</InlineWarning>;
    } else if (crewMateId === "") {
      crewMateHint = `Sans équipier, l'ambulance ne sera pas planifiée : elle part à deux. Requis : ${qualificationRequirement(crewRule)}.`;
    } else {
      crewMateHint = `Une ambulance part à deux. Requis : ${qualificationRequirement(crewRule)}.`;
    }
  }

  return (
    <>
      <Fieldset legend="Identification">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Libellé" htmlFor="label" hint="Nom usuel, ex. « Taxi 3 Manosque »." error={errors.label} className="lg:col-span-2">
            <Input
              id="label"
              name="label"
              required
              maxLength={60}
              defaultValue={valueOf(values, "label")}
              aria-invalid={Boolean(errors.label)}
            />
          </Field>
          <Field
            label="Immatriculation"
            htmlFor="registration"
            hint="Convertie en majuscules, ex. AB-123-CD."
            error={errors.registration}
            className="lg:col-span-2"
          >
            <Input
              id="registration"
              name="registration"
              required
              maxLength={15}
              autoComplete="off"
              spellCheck={false}
              className="font-mono uppercase"
              defaultValue={valueOf(values, "registration")}
              aria-invalid={Boolean(errors.registration)}
            />
          </Field>
          <Field label="Type de véhicule" htmlFor="type" error={errors.type} className="lg:col-span-2">
            <Select
              id="type"
              name="type"
              value={type}
              onChange={(e) => {
                if (isVehicleType(e.target.value)) changeType(e.target.value);
              }}
              aria-invalid={Boolean(errors.type)}
            >
              {VEHICLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {VEHICLE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          {isAmbulance ? (
            <Field
              label="Capacité (patients)"
              htmlFor="capacity"
              hint="Ambulance : 1 patient allongé, jamais de transport partagé."
              className="lg:col-span-2"
            >
              <UnitInput id="capacity" name="capacity" value="1" readOnly unit="patient" className="bg-slate-50" />
            </Field>
          ) : (
            <Field
              label="Capacité (patients simultanés)"
              htmlFor="capacity"
              hint="Règle de V : 2 patients. Les textes VSL (avenant 11) autorisent jusqu'à 3."
              error={errors.capacity}
              className="lg:col-span-2"
            >
              <Select
                id="capacity"
                name="capacity"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                aria-invalid={Boolean(errors.capacity)}
              >
                {Array.from({ length: MAX_SHARED_CAPACITY }, (_, i) => String(i + 1)).map((n) => (
                  <option key={n} value={n}>
                    {n === "1"
                      ? "1 patient (pas de partage)"
                      : n === "2"
                        ? "2 patients (règle de V)"
                        : `${n} patients (maximum des textes VSL)`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      </Fieldset>

      <Fieldset legend="Dépôt">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Nom du dépôt"
            htmlFor="depotLabel"
            hint="Ex. « Dépôt Sisteron »."
            error={errors.depotLabel}
            className="lg:col-span-2"
          >
            <Input
              id="depotLabel"
              name="depotLabel"
              required
              maxLength={60}
              defaultValue={valueOf(values, "depotLabel")}
              aria-invalid={Boolean(errors.depotLabel)}
            />
          </Field>
          <Field
            label="Département de rattachement"
            htmlFor="department"
            hint="Sélectionne la grille tarifaire (ex. 13, 04, 05, 38, 2A)."
            error={errors.department}
            className="lg:col-span-2"
          >
            <Input
              id="department"
              name="department"
              required
              maxLength={3}
              list="department-options"
              autoComplete="off"
              className="uppercase sm:max-w-40"
              defaultValue={valueOf(values, "department")}
              aria-invalid={Boolean(errors.department)}
            />
            <datalist id="department-options">
              {Object.entries(DEPARTMENT_NAMES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </datalist>
          </Field>
          <Field
            label="Adresse du dépôt"
            htmlFor="depotAddress"
            hint="Point de départ et de retour des tournées."
            error={errors.depotAddress}
            className="sm:col-span-2 lg:col-span-4"
          >
            <Input
              id="depotAddress"
              name="depotAddress"
              required
              maxLength={200}
              autoComplete="street-address"
              defaultValue={valueOf(values, "depotAddress")}
              aria-invalid={Boolean(errors.depotAddress)}
            />
          </Field>
          <Field label="Latitude" htmlFor="depotLat" error={errors.depotLat}>
            <Input
              id="depotLat"
              name="depotLat"
              required
              inputMode="decimal"
              autoComplete="off"
              placeholder="43.2965"
              className="tabular"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              onPaste={pasteCoordinates}
              aria-invalid={Boolean(errors.depotLat)}
              aria-describedby="coordinates-hint"
            />
          </Field>
          <Field label="Longitude" htmlFor="depotLng" error={errors.depotLng}>
            <Input
              id="depotLng"
              name="depotLng"
              required
              inputMode="decimal"
              autoComplete="off"
              placeholder="5.3698"
              className="tabular"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              onPaste={pasteCoordinates}
              aria-invalid={Boolean(errors.depotLng)}
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
        </div>
      </Fieldset>

      <Fieldset legend="Équipage par défaut">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Chauffeur par défaut"
            htmlFor="defaultDriverId"
            error={errors.defaultDriverId}
            hint={driverHint}
          >
            <Select
              id="defaultDriverId"
              name="defaultDriverId"
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              aria-invalid={Boolean(errors.defaultDriverId)}
            >
              <option value="">— Aucun chauffeur par défaut —</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {driverOptionLabel(d, driverRule)}
                </option>
              ))}
            </Select>
          </Field>
          {isAmbulance && crewRule ? (
            <Field
              label="Équipier par défaut"
              htmlFor="defaultCrewMateId"
              error={errors.defaultCrewMateId}
              hint={crewMateHint}
            >
              <Select
                id="defaultCrewMateId"
                name="defaultCrewMateId"
                value={crewMateId}
                onChange={(e) => setCrewMateId(e.target.value)}
                aria-invalid={Boolean(errors.defaultCrewMateId)}
              >
                <option value="">— Aucun équipier par défaut —</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id} disabled={d.id === driverId}>
                    {driverOptionLabel(d, crewRule)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="self-end pb-2 text-xs text-slate-500">
              Taxi et VSL : un seul chauffeur. L&apos;équipier ne concerne que les ambulances.
            </p>
          )}
        </div>
      </Fieldset>

      <Fieldset legend="Coût d'exploitation">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Coût kilométrique (€/km)"
            htmlFor="costPerKm"
            error={errors.costPerKm}
            hint="Carburant, entretien, usure : utilisé par l'optimiseur pour calculer la marge."
            className="sm:col-span-2"
          >
            <UnitInput
              id="costPerKm"
              name="costPerKm"
              required
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,32"
              unit="€/km"
              className="sm:max-w-48"
              defaultValue={valueOf(values, "costPerKm")}
              aria-invalid={Boolean(errors.costPerKm)}
            />
          </Field>
        </div>
      </Fieldset>
    </>
  );
}

function driverOptionLabel(driver: DriverOption, required: readonly Qualification[]): string {
  const notes: string[] = [];
  if (!driver.active) notes.push("désactivé");
  if (!hasRequiredQualification(driver.qualifications, required)) notes.push("non qualifié");
  const [first, ...rest] = driver.seats;
  if (first) notes.push(`déjà sur ${first.label}${rest.length > 0 ? ` +${rest.length}` : ""}`);
  return notes.length > 0 ? `${driver.name} (${notes.join(", ")})` : driver.name;
}
