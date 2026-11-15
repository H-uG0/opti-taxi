import type { ReactNode } from "react";
import Link from "next/link";
import { Car, ChevronDown, ClipboardCheck, Coffee, Flag, Info, Warehouse } from "lucide-react";
import { Badge, VehicleTypeBadge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { formatKm, STOP_KIND_LABELS } from "@/lib/labels";
import { formatDuration, formatMinute } from "@/lib/time";
import type { RegulatorContact } from "../_lib/links";
import type { VehicleDay } from "../_lib/load";
import { FuelForm } from "./fuel-form";
import { OdometerCard } from "./odometer-card";
import type { RouteView, StopView } from "../_lib/view";
import { NavLinks } from "./nav-links";
import { PhoneLink } from "./phone-link";
import { StopCard } from "./stop-card";

function HeaderFigure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-white px-4 py-2.5">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="tabular mt-0.5 text-lg font-semibold text-slate-900">{children}</dd>
    </div>
  );
}

function RouteHeader({ route, titleId }: { route: RouteView; titleId: string }) {
  const { vehicle, progress } = route;
  const percent = progress.total > 0 ? Math.round((progress.closed / progress.total) * 100) : 0;
  const pause = route.plannedBreak
    ? `${formatMinute(route.plannedBreak.startMinute)} – ${formatMinute(route.plannedBreak.endMinute)}`
    : route.breakWindow
      ? `${formatDuration(route.breakWindow.minutes)}`
      : "Aucune";

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-xs">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-lg font-bold text-slate-950">
            {vehicle.label}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <VehicleTypeBadge type={vehicle.type} />
            <span className="tabular font-medium">{vehicle.registration}</span>
          </p>
        </div>
        {route.status === "VALIDATED" ? <Badge tone="success">Validée</Badge> : <Badge tone="warning">Provisoire</Badge>}
      </div>

      {route.status === "PROPOSED" ? (
        <p className="border-y border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950">
          Tournée provisoire&nbsp;: elle peut encore changer avant sa validation par la régulation.
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-px border-y border-slate-200 bg-slate-200">
        <HeaderFigure label="Départ">{formatMinute(route.startMinute)}</HeaderFigure>
        <HeaderFigure label="Retour">{formatMinute(route.endMinute)}</HeaderFigure>
        <HeaderFigure label="Distance">{formatKm(route.distanceKm, 0)}</HeaderFigure>
        <HeaderFigure label="Pause prévue">{pause}</HeaderFigure>
      </dl>

      <div className="space-y-2 px-4 py-3 text-sm text-slate-700">
        {route.breakWindow ? (
          <p>
            Pause de <span className="tabular font-semibold">{formatDuration(route.breakWindow.minutes)}</span> à prendre entre{" "}
            <span className="tabular font-semibold">{formatMinute(route.breakWindow.startMinute)}</span> et{" "}
            <span className="tabular font-semibold">{formatMinute(route.breakWindow.endMinute)}</span>.
          </p>
        ) : null}
        {route.partner ? (
          <p>
            {route.role === "DRIVER" ? "Équipier" : "Conducteur"}&nbsp;: <span className="font-semibold text-slate-900">{route.partner}</span>
          </p>
        ) : null}
        {route.partner && route.partnerPhone ? (
          <PhoneLink
            href={route.partnerPhone.href}
            label={route.role === "DRIVER" ? "Appeler l'équipier" : "Appeler le conducteur"}
            number={route.partnerPhone.number}
          />
        ) : null}
        <p>
          Dépôt&nbsp;: <span className="font-semibold text-slate-900">{vehicle.depot.name}</span>
        </p>
        <div>
          <p className="tabular flex justify-between font-medium text-slate-800">
            <span>
              {progress.closed} / {progress.total} arrêts faits
            </span>
            <span>{percent}&nbsp;%</span>
          </p>
          <div aria-hidden className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-emerald-600" style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function NextStopLink({ stop }: { stop: StopView }) {
  return (
    <a
      href={`#stop-${stop.id}`}
      className="flex min-h-14 touch-manipulation items-center gap-3 rounded-2xl bg-brand-800 px-4 py-2.5 text-white shadow-sm hover:bg-brand-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold uppercase tracking-wide text-brand-200">Aller au prochain arrêt</span>
        <span className="block truncate text-base font-semibold">
          <span className="tabular">{formatMinute(stop.plannedMinute)}</span> · {STOP_KIND_LABELS[stop.kind]} · {stop.patient}
        </span>
      </span>
      <ChevronDown aria-hidden className="size-6 shrink-0" />
    </a>
  );
}

function Marker({
  icon,
  minute,
  children,
  notes,
  className,
}: {
  icon: ReactNode;
  minute: number;
  children: ReactNode;
  /** Access to the depot (gate, keys, parking), under the line. */
  notes?: string | null;
  className?: string;
}) {
  return (
    <li className={cn("rounded-2xl border border-dashed border-slate-300 bg-white/70 px-4 py-2", className)}>
      <div className="flex min-h-8 items-center gap-3">
        <span aria-hidden className="shrink-0 text-slate-500">
          {icon}
        </span>
        <span className="tabular text-base font-semibold text-slate-800">{formatMinute(minute)}</span>
        <span className="min-w-0 flex-1 text-sm text-slate-700">{children}</span>
      </div>
      {notes ? <DepotNotes notes={notes} className="mt-1.5" /> : null}
    </li>
  );
}

function DepotNotes({ notes, className }: { notes: string; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-sm whitespace-pre-line text-slate-700", className)}>
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-slate-500" />
      <span>
        <span className="font-semibold">Accès au dépôt&nbsp;: </span>
        {notes}
      </span>
    </p>
  );
}

/**
 * Return to the depot. Once every stop is closed it becomes the next thing to do, with its navigation links and the
 * odometer to read back at the depot (FLD-03: without it, no real km against the planned ones).
 */
function ReturnMarker({ route, finished, vehicleDay }: { route: RouteView; finished: boolean; vehicleDay: VehicleDay | null }) {
  const { vehicle } = route;
  if (!finished) {
    return (
      <Marker icon={<Warehouse className="size-5" />} minute={route.endMinute} notes={vehicle.depot.notes}>
        Retour au dépôt · {vehicle.depot.name}
      </Marker>
    );
  }
  if (route.waitingPatients.length > 0) {
    // A breakdown left a patient on board: the crew stays with them until the vehicle picking them up arrives.
    return (
      <li className="scroll-mt-24 space-y-2 rounded-2xl border border-amber-300 bg-amber-50 p-4">
        <p className="flex items-center gap-2 text-base font-semibold text-amber-950">
          <Flag aria-hidden className="size-5" />
          Tournée interrompue&nbsp;: restez avec {route.waitingPatients.length > 1 ? "les patients" : "le patient"}
        </p>
        <ul className="space-y-1 text-sm text-amber-950">
          {route.waitingPatients.map((waiting) => (
            <li key={waiting.patient}>
              <span className="font-semibold">{waiting.patient}</span>
              {waiting.pickupMinute !== null ? (
                <>
                  {" "}
                  · repris par un autre véhicule vers <span className="tabular font-semibold">{formatMinute(waiting.pickupMinute)}</span>
                </>
              ) : (
                " · un autre véhicule va être envoyé, la régulation vous appelle"
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-amber-950">Le retour au dépôt vient ensuite ({vehicle.depot.name}).</p>
      </li>
    );
  }
  return (
    <li className="scroll-mt-24 space-y-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-4">
      <p className="flex items-center gap-2 text-base font-semibold text-emerald-950">
        <Flag aria-hidden className="size-5" />
        Tous les arrêts sont faits&nbsp;: retour au dépôt
      </p>
      <p className="text-sm text-emerald-950">
        <span className="font-semibold">{vehicle.depot.name}</span> · {vehicle.depot.address} · prévu à{" "}
        <span className="tabular font-semibold">{formatMinute(route.endMinute)}</span>
      </p>
      {vehicle.depot.notes ? <DepotNotes notes={vehicle.depot.notes} /> : null}
      <NavLinks lat={vehicle.depot.lat} lng={vehicle.depot.lng} destination={vehicle.depot.address} />
      {vehicleDay ? (
        <OdometerCard
          routeId={route.id}
          date={vehicleDay.date}
          moment="END"
          recorded={vehicleDay.end}
          lastKnown={vehicleDay.lastKnown}
          startKm={vehicleDay.start}
          prominent={vehicleDay.end === null}
        />
      ) : null}
    </li>
  );
}

/**
 * « Fin de tournée » (FLD-02): the stops left without a status (their time past), and the way to enter them; the
 * odometer back at the depot while it is not read (FLD-03).
 */
function EndOfRouteLink({ forgotten, endReadingMissing }: { forgotten: number; endReadingMissing: boolean }) {
  return (
    <Link
      href="/chauffeur/fin-de-tournee"
      prefetch={false}
      className={cn(
        "flex min-h-14 touch-manipulation items-center gap-3 rounded-2xl border px-4 py-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
        forgotten > 0 ? "border-amber-400 bg-amber-50 text-amber-950 hover:bg-amber-100" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50",
      )}
    >
      <ClipboardCheck aria-hidden className="size-5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold">Fin de tournée</span>
        <span className="block text-sm">
          {forgotten > 0
            ? `${forgotten > 1 ? `${forgotten} arrêts` : "1 arrêt"} sans statut\u00a0: saisissez l'heure réelle${endReadingMissing ? " · compteur au retour" : ""}`
            : endReadingMissing
              ? "Compteur au retour, statuts oubliés avec l'heure réelle"
              : "Statuts oubliés, avec l'heure réelle"}
        </span>
      </span>
    </Link>
  );
}

/** The day's vehicle (FLD-03): the odometer at the start and the end, a fill-up or a charge. */
export function VehicleDayPanel({
  routeId,
  day,
  open = false,
  readings = true,
  endReading = true,
}: {
  routeId: string;
  day: VehicleDay;
  open?: boolean;
  /** The odometer readings too (« Fin de tournée » shows the end's on its own). */
  readings?: boolean;
  /** The end's reading in the panel (false once the route is finished: the return to the depot shows it). */
  endReading?: boolean;
}) {
  return (
    <details open={open} className="group rounded-2xl border border-slate-300 bg-white">
      <summary className="flex min-h-14 cursor-pointer touch-manipulation list-none items-center gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-600 [&::-webkit-details-marker]:hidden">
        <Car aria-hidden className="size-5 shrink-0 text-brand-700" />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold text-slate-950">Véhicule</span>
          <span className="block text-sm text-slate-600">
            {readings ? "Compteur, " : ""}
            {day.energy === "ELECTRIC" ? "recharge" : "plein ou recharge"}
          </span>
        </span>
        <ChevronDown aria-hidden className="size-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-slate-200 px-3 py-3">
        {readings ? (
          <>
            {/* Missing, the start's card is at the top of the route (the first thing of the day). */}
            {day.start !== null ? (
              <OdometerCard routeId={routeId} date={day.date} moment="START" recorded={day.start} lastKnown={day.lastKnown} startKm={null} endKm={day.end} />
            ) : null}
            {endReading ? (
              <OdometerCard routeId={routeId} date={day.date} moment="END" recorded={day.end} lastKnown={day.lastKnown} startKm={day.start} />
            ) : null}
          </>
        ) : null}
        <div className="rounded-2xl border border-slate-200 px-3 py-3">
          <FuelForm routeId={routeId} energy={day.energy} odometerHint={day.end ?? day.start} />
        </div>
      </div>
    </details>
  );
}

export function RouteSection({
  route,
  regulator,
  endOfRoute = null,
  vehicleDay = null,
}: {
  route: RouteView;
  regulator: RegulatorContact | null;
  /** Today's route: the stops left without a status although their time is past (« Fin de tournée »). */
  endOfRoute?: { forgotten: number } | null;
  /** Today's route: the vehicle's odometer readings and fill-ups (FLD-03). */
  vehicleDay?: VehicleDay | null;
}) {
  const titleId = `route-${route.id}`;
  const finished = route.stops.length > 0 && route.nextStop === null;
  const stopIds = route.stops.map((stop) => stop.id);
  // Once every stop is done, the odometer back at the depot is on the return's card (the task of the moment).
  const endOnReturn = vehicleDay !== null && finished && route.waitingPatients.length === 0;

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <RouteHeader route={route} titleId={titleId} />
      {/* The first thing of the day: the odometer as the vehicle leaves the depot. */}
      {vehicleDay && vehicleDay.start === null ? (
        <OdometerCard
          routeId={route.id}
          date={vehicleDay.date}
          moment="START"
          recorded={null}
          lastKnown={vehicleDay.lastKnown}
          startKm={null}
          endKm={vehicleDay.end}
          prominent
        />
      ) : null}
      {route.nextStop && route.progress.closed > 0 ? <NextStopLink stop={route.nextStop} /> : null}
      <ol aria-label={`Arrêts de la tournée ${route.vehicle.label}`} className="space-y-3">
        {route.timeline.map((item) => {
          switch (item.type) {
            case "depart":
              return (
                <Marker key="depart" icon={<Warehouse className="size-5" />} minute={item.minute} notes={route.vehicle.depot.notes}>
                  Départ du dépôt · {route.vehicle.depot.name}
                </Marker>
              );
            case "break":
              return (
                <Marker key="break" icon={<Coffee className="size-5" />} minute={item.startMinute} className="border-solid bg-slate-100">
                  Pause jusqu&apos;à <span className="tabular font-semibold">{formatMinute(item.endMinute)}</span> (
                  {formatDuration(item.endMinute - item.startMinute)})
                </Marker>
              );
            case "stop":
              return <StopCard key={item.stop.id} stop={item.stop} routeStopIds={stopIds} regulator={regulator} />;
            case "return":
              return <ReturnMarker key="return" route={route} finished={finished} vehicleDay={endOnReturn ? vehicleDay : null} />;
          }
        })}
      </ol>
      {endOfRoute ? <EndOfRouteLink forgotten={endOfRoute.forgotten} endReadingMissing={vehicleDay !== null && vehicleDay.end === null} /> : null}
      {vehicleDay ? <VehicleDayPanel routeId={route.id} day={vehicleDay} endReading={!endOnReturn} /> : null}
    </section>
  );
}
