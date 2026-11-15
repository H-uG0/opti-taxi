"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  CalendarClock,
  CarFront,
  CircleSlash,
  Clock4,
  FileWarning,
  Hourglass,
  House,
  LockKeyholeOpen,
  MessageSquareWarning,
  OctagonAlert,
  PhoneOff,
  RotateCcw,
  UserX,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/layout";
import { cn } from "@/components/ui/cn";
import { OUTBOUND_NO_SHOW_ADVICE, OUTBOUND_NO_SHOW_SHORT_LABEL } from "@/lib/domain/no-show";
import type { DroppedLock } from "@/lib/optimizer/build-request";
import { fieldRequestText, type FieldRequestView } from "@/lib/domain/field-requests";
import type { LongWait, OverdueStop, SilentRoute, ThreatenedAppointment } from "@/lib/planning/live-day";
import type { VehicleIssue } from "@/lib/planning/route-issues";
import type { TripView, UnassignedView, ViolationView } from "@/lib/planning/types";
import { DIRECTION_LABELS } from "@/lib/labels";
import { formatDuration, formatMinute } from "@/lib/time";

/** What the day's follow-up adds to « À traiter » (DAY-01, DAY-05), today only. */
export type LiveIssues = {
  nowMinute: number;
  maxTotalWaitMin: number;
  /** The crews' requests still to handle, with the regulator's buttons for each. */
  requests: FieldRequestView[];
  requestActions: (request: FieldRequestView) => ReactNode;
  threatened: ThreatenedAppointment[];
  silent: SilentRoute[];
  overdue: OverdueStop[];
  longWaits: LongWait[];
  /** Crews that have not seen a change of their roadmap. */
  unseenRoadmaps: { vehicleId: string; text: string }[];
};

/** « 10:05 » of an ISO instant (Europe/Paris). */
function clockOf(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export type IssuesPanelProps = {
  date: string;
  unassigned: UnassignedView[];
  violations: ViolationView[];
  violationsKnown: boolean;
  staleTrips: UnassignedView[];
  droppedLocks: DroppedLock[];
  /** Return trips to check: their outbound leg was closed as "patient absent". */
  returnsToCheck: string[];
  /** Routes planned before a change of vehicle or crew, overdue inspection or insurance. */
  vehicleIssues: VehicleIssue[];
  /** Why the day cannot be re-optimized now (validated, past, started, computation running), or null. */
  replanBlocked?: string | null;
  /** Validated or started day: a crew changes on the route itself (« Changer l'équipage »). */
  crewChangeOnRoute?: boolean;
  trips: Record<string, TripView>;
  vehicleLabels: Record<string, string>;
  planned: boolean;
  selectedTripId: string | null;
  onSelectTrip: (tripId: string) => void;
  onSelectVehicle: (vehicleId: string) => void;
  /** Today: the day's follow-up (threatened appointments, silent routes, requests of the crews…). */
  live?: LiveIssues | null;
};

function tripTimeLabel(trip: TripView | undefined): string {
  if (!trip) return "";
  return trip.direction === "OUTBOUND"
    ? `${DIRECTION_LABELS.OUTBOUND} · RDV ${formatMinute(trip.appointmentMinute)}`
    : `${DIRECTION_LABELS.RETURN} · fin ${formatMinute(trip.readyMinute)}`;
}

function TripButton({
  tripId,
  trips,
  selected,
  onSelect,
  children,
}: {
  tripId: string;
  trips: Record<string, TripView>;
  selected: boolean;
  onSelect: (tripId: string) => void;
  children?: ReactNode;
}) {
  const trip = trips[tripId];
  return (
    <button
      type="button"
      onClick={() => onSelect(tripId)}
      aria-pressed={selected}
      className={cn(
        "block w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600",
        selected && "bg-brand-50 hover:bg-brand-50",
      )}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-slate-900">{trip?.patientName ?? "Course supprimée"}</span>
        <span className="tabular shrink-0 text-xs text-slate-500">{tripTimeLabel(trip)}</span>
      </span>
      {children ? <span className="mt-0.5 block text-xs text-slate-600">{children}</span> : null}
    </button>
  );
}

function VehicleButton({ label, onSelect, children }: { label: string; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
    >
      <span className="block truncate text-sm font-medium text-slate-900">{label}</span>
      <span className="mt-0.5 block text-xs text-slate-600">{children}</span>
    </button>
  );
}

function Section({
  icon,
  title,
  tone,
  intro,
  children,
}: {
  icon: ReactNode;
  title: string;
  tone: "red" | "amber" | "slate";
  /** What to do, said once for every entry of the section. */
  intro?: ReactNode;
  children: ReactNode;
}) {
  const tones = { red: "text-red-700", amber: "text-amber-700", slate: "text-slate-700" };
  return (
    <section className="px-2 py-2">
      <h3 className={cn("flex items-center gap-1.5 px-2 pb-1 text-xs font-semibold uppercase tracking-wide", tones[tone])}>
        {icon}
        {title}
      </h3>
      {intro ? <p className="px-2 pb-1.5 text-xs text-slate-600">{intro}</p> : null}
      <ul className="max-h-72 space-y-0.5 overflow-y-auto">{children}</ul>
    </section>
  );
}

/** What to do about vehicles to review, said once for the section (when re-optimizing is not possible now, why). */
function vehicleIssuesIntro(
  issues: readonly VehicleIssue[],
  date: string,
  replanBlocked: string | null,
  crewChangeOnRoute: boolean,
): ReactNode {
  const changed = issues.some((issue) => issue.changes.length > 0);
  const compliance = issues.some((issue) => issue.compliance.length > 0);
  let changedText: string | null = null;
  if (changed) {
    if (crewChangeOnRoute) {
      changedText =
        "Changements survenus depuis le calcul\u00a0: pour remplacer une personne sans réoptimiser, sélectionnez le véhicule puis «\u202fChanger l'équipage\u202f». ";
    } else if (replanBlocked) changedText = `Changements survenus depuis le calcul. ${replanBlocked} `;
    else changedText = "Changements survenus depuis le calcul\u00a0: réoptimisez pour appliquer les équipages du jour. ";
  }
  return (
    <>
      {changedText}
      {compliance ? "Échéance dépassée\u00a0: vérifiez le véhicule avant de le faire rouler. " : null}
      <Link href={`/equipages?date=${date}`} className="font-medium text-brand-700 underline-offset-2 hover:underline">
        Équipages du jour
      </Link>
    </>
  );
}

/** Why a leg without a vehicle comes first: the patient's other leg is planned. */
function halfServedText(trip: TripView | undefined, vehicleLabel: string): string {
  return trip?.direction === "OUTBOUND"
    ? `Aller sans véhicule\u00a0: le retour est planifié sur ${vehicleLabel}`
    : `Retour sans véhicule\u00a0: l'aller est planifié sur ${vehicleLabel}`;
}

/** Everything the regulator should look at: half-served patients, vehicles to review, returns after an absence, unassigned trips, violations, stale or ignored locks. */
export function IssuesPanel({
  date,
  unassigned,
  violations,
  violationsKnown,
  staleTrips,
  droppedLocks,
  returnsToCheck,
  vehicleIssues,
  replanBlocked = null,
  crewChangeOnRoute = false,
  trips,
  vehicleLabels,
  planned,
  selectedTripId,
  onSelectTrip,
  onSelectVehicle,
  live = null,
}: IssuesPanelProps) {
  // Sections by severity: the crews' requests, then a patient driven to the facility and not back home (or the
  // reverse), the appointments at risk, the silent routes, the vehicles to review and the returns after an absence
  // (the order of issueTargets); the amber ones after.
  const halfServed = planned ? unassigned.filter((u) => u.servedPartner) : [];
  const otherUnassigned = planned ? unassigned.filter((u) => !u.servedPartner) : unassigned;
  const count =
    vehicleIssues.length +
    returnsToCheck.length +
    (planned ? unassigned.length : 0) +
    violations.length +
    staleTrips.length +
    droppedLocks.length +
    (violationsKnown ? 0 : 1) +
    (live
      ? live.requests.length + live.threatened.length + live.silent.length + live.overdue.length + live.longWaits.length + live.unseenRoadmaps.length
      : 0);
  const vehicleOf = (vehicleId: string | null) => (vehicleId ? (vehicleLabels[vehicleId] ?? "Véhicule") : "sans véhicule");

  return (
    <Card>
      <CardHeader title={planned ? `À traiter (${count})` : `Courses à planifier (${unassigned.length})`} />
      {count === 0 && planned ? (
        <p className="px-4 py-4 text-sm text-emerald-700">Toutes les courses sont affectées, sans violation.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {!violationsKnown ? (
            <p className="px-4 py-3 text-sm text-amber-800">
              Le dernier calcul signalait des violations, mais leur détail n&apos;a pas été enregistré (calcul plus
              ancien)&nbsp;: relancez l&apos;optimisation pour les revoir.
            </p>
          ) : null}

          {live && live.requests.length > 0 ? (
            <Section
              icon={<MessageSquareWarning aria-hidden className="size-3.5" />}
              title={`Demandes des équipages (${live.requests.length})`}
              tone="red"
              intro="Une fin de séance signalée est déjà enregistrée sur le retour&nbsp;: replacez-le si besoin («&#x202F;Où placer&#x202F;»). Un retard annoncé décale déjà les heures estimées de la tournée. «&#x202F;Patient pas prêt&#x202F;»&nbsp;: l'équipage attend sur place, appelez-le si l'attente dure. Retards et «&#x202F;pas prêt&#x202F;» quittent la liste dès que l'arrêt a son statut. Une annulation ou un retour attend votre réponse."
            >
              {live.requests.map((request) => (
                <li key={request.id} className="space-y-1">
                  <TripButton tripId={request.tripId} trips={trips} selected={request.tripId === selectedTripId} onSelect={onSelectTrip}>
                    <span className="font-medium text-red-800">{fieldRequestText(request)}</span>
                    <span className="block">
                      {request.createdBy ?? "Équipage"}, à {clockOf(request.createdAt)}
                      {trips[request.tripId]?.vehicleId ? ` · ${vehicleOf(trips[request.tripId]?.vehicleId ?? null)}` : ""}
                    </span>
                  </TripButton>
                  <div className="px-2 pb-1">{live.requestActions(request)}</div>
                </li>
              ))}
            </Section>
          ) : null}

          {halfServed.length > 0 ? (
            <Section
              icon={<House aria-hidden className="size-3.5" />}
              title={`Aller ou retour sans véhicule (${halfServed.length})`}
              tone="red"
              intro="L'autre trajet du patient est planifié&nbsp;: sans celui-ci, il reste au lieu de soins ou n'y est pas conduit. Placez la course à la main, réoptimisez, ou annulez-la avec le motif «&#x202F;Confiée à un confrère&#x202F;»."
            >
              {halfServed.map((u) => (
                <li key={u.tripId}>
                  <TripButton tripId={u.tripId} trips={trips} selected={u.tripId === selectedTripId} onSelect={onSelectTrip}>
                    <span className="font-medium text-red-800">
                      {halfServedText(trips[u.tripId], vehicleLabels[u.servedPartner?.vehicleId ?? ""] ?? "un véhicule")}
                    </span>
                    <span className="block">{u.reason}</span>
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {live && live.threatened.length > 0 ? (
            <Section
              icon={<CalendarClock aria-hidden className="size-3.5" />}
              title={`RDV menacés (${live.threatened.length})`}
              tone="red"
              intro="Arrivée estimée à partir des derniers statuts saisis et des temps du planning (aucune position GPS)&nbsp;: prévenez l'établissement ou replacez la course."
            >
              {live.threatened.map((t) => (
                <li key={t.tripId}>
                  <TripButton tripId={t.tripId} trips={trips} selected={t.tripId === selectedTripId} onSelect={onSelectTrip}>
                    <span className="font-medium text-red-800">
                      Arrivée vers {formatMinute(t.projectedMinute)}, {formatDuration(t.lateMinutes)} après le RDV
                    </span>
                    <span className="block">{vehicleOf(t.vehicleId)}</span>
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {live && live.silent.length > 0 ? (
            <Section
              icon={<PhoneOff aria-hidden className="size-3.5" />}
              title={`Tournées silencieuses (${live.silent.length})`}
              tone="red"
              intro="Aucun statut saisi 15&nbsp;min après la première prise en charge prévue&nbsp;: appelez l'équipage."
            >
              {live.silent.map((s) => (
                <li key={s.vehicleId}>
                  <VehicleButton label={vehicleOf(s.vehicleId)} onSelect={() => onSelectVehicle(s.vehicleId)}>
                    <span className="font-medium text-red-800">
                      Aucun statut depuis {formatMinute(s.sinceMinute)} ({formatDuration(s.minutes)})
                    </span>
                  </VehicleButton>
                </li>
              ))}
            </Section>
          ) : null}

          {vehicleIssues.length > 0 ? (
            <Section
              icon={<CarFront aria-hidden className="size-3.5" />}
              title={`Véhicules à revoir (${vehicleIssues.length})`}
              tone="red"
              intro={vehicleIssuesIntro(vehicleIssues, date, replanBlocked, crewChangeOnRoute)}
            >
              {vehicleIssues.map((issue) => (
                <li key={issue.vehicleId}>
                  <button
                    type="button"
                    onClick={() => onSelectVehicle(issue.vehicleId)}
                    className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-slate-900">{issue.label}</span>
                      <span className="shrink-0 text-xs text-slate-500">{issue.hasRoute ? "Tournée calculée" : "Sans tournée"}</span>
                    </span>
                    {issue.changes.map((message) => (
                      <span key={message} className="mt-0.5 block text-xs font-medium text-red-800">
                        {message}
                      </span>
                    ))}
                    {issue.compliance.map((message) => (
                      <span key={message} className="mt-0.5 block text-xs text-amber-800">
                        {message}
                      </span>
                    ))}
                  </button>
                </li>
              ))}
            </Section>
          ) : null}

          {returnsToCheck.length > 0 ? (
            <Section
              icon={<UserX aria-hidden className="size-3.5" />}
              title={`Retours à vérifier (${returnsToCheck.length})`}
              tone="red"
              intro={OUTBOUND_NO_SHOW_ADVICE}
            >
              {returnsToCheck.map((tripId) => (
                <li key={tripId}>
                  <TripButton tripId={tripId} trips={trips} selected={tripId === selectedTripId} onSelect={onSelectTrip}>
                    <span className="font-medium text-red-800">{OUTBOUND_NO_SHOW_SHORT_LABEL}</span>
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {violations.length > 0 ? (
            <Section icon={<OctagonAlert aria-hidden className="size-3.5" />} title={`Violations (${violations.length})`} tone="red">
              {violations.map((v, i) => (
                <li key={i} className="rounded-md px-2 py-1.5">
                  <p className="text-sm font-medium text-red-800">{v.label}</p>
                  <p className="text-xs text-slate-600">{v.message}</p>
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {v.tripId ? (
                      <button
                        type="button"
                        onClick={() => onSelectTrip(v.tripId ?? "")}
                        className="inline-flex min-h-6 items-center rounded border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
                      >
                        {trips[v.tripId]?.patientName ?? "Course"}
                      </button>
                    ) : null}
                    {v.vehicleId ? (
                      <button
                        type="button"
                        onClick={() => onSelectVehicle(v.vehicleId ?? "")}
                        className="inline-flex min-h-6 items-center rounded border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600"
                      >
                        {vehicleLabels[v.vehicleId] ?? "Véhicule"}
                      </button>
                    ) : null}
                  </p>
                </li>
              ))}
            </Section>
          ) : null}

          {live && live.overdue.length > 0 ? (
            <Section
              icon={<Clock4 aria-hidden className="size-3.5" />}
              title={`Arrêts sans statut (${live.overdue.length})`}
              tone="amber"
              intro="Heure dépassée de plus de 10&nbsp;min sans statut, ou statut oublié avant un arrêt déjà fait."
            >
              {live.overdue.map((o) => (
                <li key={o.stopId}>
                  <TripButton tripId={o.tripId} trips={trips} selected={o.tripId === selectedTripId} onSelect={onSelectTrip}>
                    <span className="font-medium text-amber-900">
                      {o.kind === "PICKUP" ? "Prise en charge" : "Dépose"}{" "}
                      {o.missing ? "sans statut, l'arrêt suivant est fait" : `attendue vers ${formatMinute(live.nowMinute - o.minutes)}, sans statut depuis ${formatDuration(o.minutes)}`}
                    </span>
                    <span className="block">{vehicleOf(o.vehicleId)}</span>
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {live && live.longWaits.length > 0 ? (
            <Section
              icon={<Hourglass aria-hidden className="size-3.5" />}
              title={`Attentes de plus de ${live.maxTotalWaitMin}\u00a0min (${live.longWaits.length})`}
              tone="amber"
              intro="Attente du patient au lieu de soins (avant le RDV et après la séance), retour estimé comme les RDV&nbsp;: replacez le retour («&#x202F;Où placer&#x202F;»)."
            >
              {live.longWaits.map((w) => (
                <li key={w.tripId}>
                  <TripButton tripId={w.tripId} trips={trips} selected={w.tripId === selectedTripId} onSelect={onSelectTrip}>
                    <span className="font-medium text-amber-900">
                      Attente estimée {formatDuration(w.waitMinutes)}, dont {formatDuration(w.afterMinutes)} après la séance
                    </span>
                    <span className="block">{vehicleOf(w.vehicleId)}</span>
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {live && live.unseenRoadmaps.length > 0 ? (
            <Section
              icon={<FileWarning aria-hidden className="size-3.5" />}
              title={`Changements pas encore vus (${live.unseenRoadmaps.length})`}
              tone="amber"
              intro="Changements que l'équipage n'a pas encore vus («&#x202F;J'ai vu&#x202F;»), ou que son téléphone n'a pas encore reçus (écran éteint, pas de réseau)&nbsp;: appelez-le si le changement est proche."
            >
              {live.unseenRoadmaps.map((r) => (
                <li key={r.vehicleId}>
                  <VehicleButton label={vehicleOf(r.vehicleId)} onSelect={() => onSelectVehicle(r.vehicleId)}>
                    {r.text}
                  </VehicleButton>
                </li>
              ))}
            </Section>
          ) : null}

          {otherUnassigned.length > 0 ? (
            <Section
              icon={<CircleSlash aria-hidden className="size-3.5" />}
              title={planned ? `Non affectées (${otherUnassigned.length})` : "En attente d'optimisation"}
              tone={planned ? "amber" : "slate"}
            >
              {otherUnassigned.map((u) => (
                <li key={u.tripId}>
                  <TripButton tripId={u.tripId} trips={trips} selected={u.tripId === selectedTripId} onSelect={onSelectTrip}>
                    {planned ? u.reason : null}
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {staleTrips.length > 0 ? (
            <Section icon={<RotateCcw aria-hidden className="size-3.5" />} title={`À revoir (${staleTrips.length})`} tone="amber">
              {staleTrips.map((s) => (
                <li key={s.tripId}>
                  <TripButton tripId={s.tripId} trips={trips} selected={s.tripId === selectedTripId} onSelect={onSelectTrip}>
                    {s.reason}
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}

          {droppedLocks.length > 0 ? (
            <Section icon={<LockKeyholeOpen aria-hidden className="size-3.5" />} title={`Courses figées ignorées (${droppedLocks.length})`} tone="amber">
              {droppedLocks.map((d) => (
                <li key={d.tripId}>
                  <TripButton tripId={d.tripId} trips={trips} selected={d.tripId === selectedTripId} onSelect={onSelectTrip}>
                    Figée sur {d.vehicleLabel ?? "un véhicule supprimé"}&nbsp;: {d.reason}
                  </TripButton>
                </li>
              ))}
            </Section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
