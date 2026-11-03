import type { ReactNode } from "react";
import {
  Accessibility,
  ArrowDownToLine,
  ArrowUpFromLine,
  BedSingle,
  Building2,
  ChevronDown,
  CircleCheck,
  CircleSlash,
  Info,
  MapPin,
  MessageSquareText,
  Phone,
  TriangleAlert,
  UserX,
  Users,
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import { formatMinute } from "@/lib/time";
import { MOBILITY_LABELS, STOP_KIND_LABELS } from "@/lib/labels";
import type { RegulatorContact } from "../_lib/links";
import type { StopView } from "../_lib/view";
import { NavLinks } from "./nav-links";
import { CallRegulator } from "./regulator-call";
import { StopActions, UndoStatus } from "./stop-actions";

const KIND_STYLES = {
  PICKUP: { icon: ArrowUpFromLine, className: "bg-brand-50 text-brand-900 ring-brand-300" },
  DROPOFF: { icon: ArrowDownToLine, className: "bg-sky-50 text-sky-900 ring-sky-300" },
} as const;

function KindChip({ kind }: { kind: StopView["kind"] }) {
  const { icon: Icon, className } = KIND_STYLES[kind];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold ring-1 ring-inset", className)}>
      <Icon aria-hidden className="size-4" />
      {STOP_KIND_LABELS[kind]}
    </span>
  );
}

/** Larger than the UI kit Badge: read at arm's length in a car. */
function Pill({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-semibold ring-1 ring-inset", className)}>
      {children}
    </span>
  );
}

function MobilityBadge({ mobility }: { mobility: StopView["mobility"] }) {
  if (mobility === "SEATED") return null;
  const Icon = mobility === "LYING" ? BedSingle : Accessibility;
  return (
    <Pill className={mobility === "LYING" ? "bg-red-50 text-red-900 ring-red-200" : "bg-sky-50 text-sky-900 ring-sky-200"}>
      <Icon aria-hidden className="size-4" />
      {MOBILITY_LABELS[mobility]}
    </Pill>
  );
}

function PhoneLink({ href, label, number }: { href: string; label: string; number: string }) {
  return (
    <a
      href={href}
      className="flex min-h-12 touch-manipulation items-center gap-3 rounded-xl border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 active:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      <Phone aria-hidden className="size-5 shrink-0 text-brand-700" />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-slate-600">{label}</span>
        <span className="tabular block truncate text-base font-semibold text-slate-900">{number}</span>
      </span>
    </a>
  );
}

function Line({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <span aria-hidden className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Details shared by open and collapsed cards. */
function StopDetails({ stop }: { stop: StopView }) {
  return (
    <>
      <Line icon={<MapPin className="size-5 text-slate-500" />}>
        <p className="text-base text-slate-900">{stop.address}</p>
      </Line>

      {stop.facility || stop.keyTime ? (
        <Line icon={<Building2 className="size-5 text-slate-500" />}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
            {stop.facility ? <span className="font-semibold text-slate-900">{stop.facility.name}</span> : null}
            {stop.keyTime ? (
              <span className="tabular rounded-md bg-amber-100 px-2 py-0.5 text-sm font-bold text-amber-950">
                {stop.keyTime.label} {formatMinute(stop.keyTime.minute)}
              </span>
            ) : null}
          </p>
        </Line>
      ) : null}

      {stop.accessNotes ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950">
          <Info aria-hidden className="mt-0.5 size-5 shrink-0" />
          <p className="text-base">
            <span className="font-semibold">Accès : </span>
            {stop.accessNotes}
          </p>
        </div>
      ) : null}

      {stop.tripNotes ? (
        <Line icon={<MessageSquareText className="size-5 text-slate-500" />}>
          <p className="text-sm text-slate-800">
            <span className="font-semibold">Note de la régulation : </span>
            {stop.tripNotes}
          </p>
        </Line>
      ) : null}

      {stop.sharedWith.length > 0 ? (
        <Line icon={<Users className="size-5 text-violet-700" />}>
          <p className="text-base text-slate-900">
            <span className="font-semibold text-violet-900">Transport partagé</span> avec {stop.sharedWith.join(", ")}
          </p>
          <p className="tabular text-sm text-slate-600">
            {stop.onBoardAfter} patient{stop.onBoardAfter > 1 ? "s" : ""} à bord après l&apos;arrêt
          </p>
        </Line>
      ) : null}

      {stop.phoneHref || stop.facility?.phoneHref ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {stop.phoneHref && stop.phone ? <PhoneLink href={stop.phoneHref} label="Appeler le patient" number={stop.phone} /> : null}
          {stop.facility?.phoneHref && stop.facility.phone ? (
            <PhoneLink href={stop.facility.phoneHref} label="Appeler l'accueil" number={stop.facility.phone} />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Return pickup of a patient absent on the outbound leg: check before driving to the facility. */
function OutboundNoShowWarning({ regulator }: { regulator: RegulatorContact | null }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2 text-red-950">
      <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-red-700" />
      <p className="text-base">
        <span className="font-bold">Aller : patient absent.</span>{" "}
        <CallRegulator regulator={regulator}>Appelez la régulation</CallRegulator> avant d&apos;aller le chercher.
      </p>
    </div>
  );
}

/** A stop still to do: everything the crew needs, then the status buttons. */
function OpenStopCard({ stop, total, regulator }: { stop: StopView; total: number; regulator: RegulatorContact | null }) {
  const { controls } = stop;
  const hasActions = controls.primary !== null || controls.noShow;
  return (
    <li
      id={`stop-${stop.id}`}
      aria-current={stop.isNext ? "step" : undefined}
      className={cn(
        "scroll-mt-24 overflow-hidden rounded-2xl border bg-white",
        stop.isNext ? "border-brand-700 shadow-md ring-2 ring-brand-700" : "border-slate-300 shadow-xs",
      )}
    >
      {stop.isNext ? (
        <p className="bg-brand-700 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white">Prochain arrêt</p>
      ) : null}
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="tabular text-3xl font-bold leading-none text-slate-950">{formatMinute(stop.plannedMinute)}</p>
          <KindChip kind={stop.kind} />
          <span className="tabular ml-auto text-sm text-slate-500">
            Arrêt {stop.position}/{total}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xl font-semibold text-slate-950">{stop.patient}</h3>
          <MobilityBadge mobility={stop.mobility} />
          {stop.sharedWith.length > 0 ? (
            <Pill className="bg-violet-50 text-violet-900 ring-violet-200">
              <Users aria-hidden className="size-4" />
              Partagé
            </Pill>
          ) : null}
        </div>

        {stop.outboundNoShow ? <OutboundNoShowWarning regulator={regulator} /> : null}

        <StopDetails stop={stop} />

        <NavLinks lat={stop.lat} lng={stop.lng} destination={stop.address} />
      </div>

      {hasActions ? (
        <div className="border-t border-slate-200 bg-slate-50 p-3">
          <StopActions
            key={`${stop.id}-${stop.state}`}
            stopId={stop.id}
            primary={controls.primary}
            blockedReason={controls.blockedReason}
            noShow={controls.noShow}
            emphasized={stop.isNext}
            patient={stop.patient}
          />
        </div>
      ) : null}
    </li>
  );
}

const CLOSED_LABELS: Record<Exclude<StopView["state"], "pending">, (kind: StopView["kind"]) => string> = {
  done: (kind) => (kind === "PICKUP" ? "Pris en charge" : "Déposé"),
  no_show: () => "Patient absent",
  skipped: () => "Dépose annulée (patient absent)",
  cancelled: () => "Course annulée",
};

function ClosedIcon({ state }: { state: StopView["state"] }) {
  if (state === "done") return <CircleCheck aria-hidden className="size-6 shrink-0 text-emerald-600" />;
  if (state === "no_show") return <UserX aria-hidden className="size-6 shrink-0 text-red-600" />;
  return <CircleSlash aria-hidden className="size-6 shrink-0 text-slate-400" />;
}

function Lateness({ minutes }: { minutes: number | null }) {
  if (minutes === null || Math.abs(minutes) < 5) return null;
  return (
    <span className={cn("tabular ml-2 rounded px-1.5 py-0.5 text-xs font-semibold", minutes > 0 ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-700")}>
      {minutes > 0 ? `+${minutes}` : `−${-minutes}`} min
    </span>
  );
}

/** A stop with nothing left to do: one line, details on demand, "Annuler" on the latest status. */
function ClosedStopCard({ stop }: { stop: StopView }) {
  if (stop.state === "pending") return null;
  const label = CLOSED_LABELS[stop.state](stop.kind);
  const struck = stop.state === "skipped" || stop.state === "cancelled";
  const shownMinute = stop.completedMinute ?? stop.plannedMinute;

  return (
    <li id={`stop-${stop.id}`} className="scroll-mt-24 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
      <details className="group">
        <summary className="flex min-h-14 cursor-pointer touch-manipulation list-none items-center gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-600 [&::-webkit-details-marker]:hidden">
          <ClosedIcon state={stop.state} />
          <span className={cn("tabular text-lg font-semibold text-slate-800", struck && "text-slate-500 line-through")}>
            {formatMinute(shownMinute)}
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-sm font-semibold", stop.state === "no_show" ? "text-red-800" : "text-slate-700")}>
              {label}
              {/* Status recorded from the other crew member's phone. */}
              {stop.recordedBy ? <span className="font-normal text-slate-600"> · par {stop.recordedBy}</span> : null}
            </span>
            <span className="block truncate text-sm text-slate-600">{stop.patient}</span>
          </span>
          <ChevronDown aria-hidden className="size-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
          <span className="sr-only">Afficher le détail</span>
        </summary>
        <div className="space-y-3 border-t border-slate-200 bg-white px-4 py-3">
          <p className="text-sm text-slate-700">
            {STOP_KIND_LABELS[stop.kind]} prévue à <span className="tabular font-semibold">{formatMinute(stop.plannedMinute)}</span>
            {stop.completedMinute !== null ? (
              <>
                {" "}
                · saisie à <span className="tabular font-semibold">{formatMinute(stop.completedMinute)}</span>
                {stop.recordedBy ? <> par {stop.recordedBy}</> : null}
                <Lateness minutes={stop.lateMinutes} />
              </>
            ) : null}
          </p>
          <StopDetails stop={stop} />
        </div>
      </details>
      {stop.controls.undo ? (
        <div className="border-t border-slate-200 bg-white p-3">
          <UndoStatus key={`${stop.id}-${stop.state}`} stopId={stop.id} label={`Annuler « ${label} »`} />
        </div>
      ) : null}
    </li>
  );
}

export function StopCard({ stop, total, regulator }: { stop: StopView; total: number; regulator: RegulatorContact | null }) {
  return stop.state === "pending" ? (
    <OpenStopCard stop={stop} total={total} regulator={regulator} />
  ) : (
    <ClosedStopCard stop={stop} />
  );
}
