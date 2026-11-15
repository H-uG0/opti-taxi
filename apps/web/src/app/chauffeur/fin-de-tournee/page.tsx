import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, CircleCheck, ClipboardCheck } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { requireDriver } from "@/lib/auth";
import { cn } from "@/components/ui/cn";
import { formatLongDate, formatMinute, minuteOfDay, todayIso } from "@/lib/time";
import { LATE_ENTRY_UNTIL_MINUTE, lateEntryDates } from "../_lib/access";
import { endOfRouteView } from "../_lib/end-of-route";
import { loadEndOfRouteRoutes, loadVehicleDays } from "../_lib/load";
import { ServerRenderMark } from "../_components/driver-app";
import { LateEntry } from "../_components/late-entry";
import { OdometerCard } from "../_components/odometer-card";
import { VehicleDayPanel } from "../_components/route-section";

export const metadata: Metadata = { title: "Fin de tournée" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const tab =
  "flex min-h-11 touch-manipulation items-center justify-center rounded-xl text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/**
 * « Fin de tournée » (FLD-02): the stops of the crew's routes left without a status, to enter with their real time
 * (late-entry.tsx), and the statuses entered so far. Today, and the day before until 03:00 (access.ts). Only the
 * stops still to enter are listed, with their patient and town: the rest of the roadmap stays on /chauffeur.
 */
export default async function EndOfRoutePage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireDriver();
  const now = new Date();
  const today = todayIso(now);
  const open = lateEntryDates(now);
  const params = await searchParams;
  const requested = typeof params.date === "string" ? params.date : null;
  if (requested !== null && !open.includes(requested)) redirect("/chauffeur/fin-de-tournee");
  const date = requested ?? today;

  const routes = await loadEndOfRouteRoutes(user.driverId, date, now);
  // Patient names of the stops left without a status are on screen: traced like the roadmap.
  await auditRead(user, { action: "roadmap.view", entity: "Driver", entityId: user.driverId, serviceDate: date, details: { page: "end_of_route" } });
  const vehicleDays = await loadVehicleDays(routes, date);
  const views = routes.map((route) => ({ route, view: endOfRouteView(route.stops), day: vehicleDays.get(route.id) ?? null }));
  const yesterday = open.length > 1 ? open[0] : null;

  return (
    <div className="space-y-4">
      <ServerRenderMark at={now.getTime()} />
      <Link href="/chauffeur" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-brand-800 underline underline-offset-2">
        <ArrowLeft aria-hidden className="size-4" />
        Feuille de route
      </Link>
      {yesterday ? (
        <nav aria-label="Jour de la tournée" className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-200 p-1">
          {[
            { iso: yesterday, label: "Hier" },
            { iso: today, label: "Aujourd'hui" },
          ].map((day) => (
            <Link
              key={day.iso}
              href={`/chauffeur/fin-de-tournee?date=${day.iso}`}
              prefetch={false}
              aria-current={day.iso === date ? "page" : undefined}
              className={cn(tab, day.iso === date ? "bg-white text-brand-800 shadow-sm" : "text-slate-700 hover:bg-slate-100")}
            >
              {day.label}
            </Link>
          ))}
        </nav>
      ) : null}
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-bold text-slate-950">
          <ClipboardCheck aria-hidden className="size-6 text-brand-700" />
          Fin de tournée
        </h1>
        <p className="text-sm text-slate-600 first-letter:uppercase">{formatLongDate(date)}</p>
        <p className="text-sm text-slate-700">
          Un arrêt oublié se saisit ici avec l&apos;heure réelle, jusqu&apos;à {formatMinute(LATE_ENTRY_UNTIL_MINUTE)} le lendemain
          {date !== today ? ` (encore possible, il est ${formatMinute(minuteOfDay(now))})` : ""}. Au-delà, la régulation corrige.
        </p>
      </div>

      {views.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-8 text-center text-base text-slate-700">Aucune tournée ce jour-là.</p>
      ) : (
        views.map(({ route, view, day }) => (
          <section key={route.id} aria-labelledby={`end-${route.id}`} className="space-y-3">
            <div className="rounded-2xl border border-slate-300 bg-white px-4 py-3">
              <h2 id={`end-${route.id}`} className="text-lg font-bold text-slate-950">
                {route.vehicle.label}
              </h2>
              <p className="tabular mt-1 text-base text-slate-800">
                Statuts saisis&nbsp;: <span className="font-semibold">{view.closed}</span> sur {view.total}
                {view.total > 0 ? ` (${Math.floor((view.closed / view.total) * 100)}\u00a0%)` : ""}
              </p>
            </div>
            {/* The end of the day: the odometer back at the depot (FLD-03); the start's, if it was forgotten. */}
            {day && day.start === null ? <OdometerCard routeId={route.id} date={day.date} moment="START" recorded={null} lastKnown={day.lastKnown} startKm={null} /> : null}
            {day ? <OdometerCard routeId={route.id} date={day.date} moment="END" recorded={day.end} lastKnown={day.lastKnown} startKm={day.start} prominent={day.end === null} /> : null}
            {view.pending.length === 0 ? (
              <p className="flex items-center gap-2 rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-base font-semibold text-emerald-950">
                <CircleCheck aria-hidden className="size-5" />
                Tous les arrêts ont un statut.
              </p>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-800">
                  {view.pending.length > 1 ? `${view.pending.length} arrêts sans statut` : "1 arrêt sans statut"}
                </p>
                <ol className="space-y-3">
                  {view.pending.map((stop) => (
                    <LateEntry
                      key={stop.id}
                      stopId={stop.id}
                      kind={stop.kind}
                      plannedMinute={stop.plannedMinute}
                      patient={stop.patient}
                      town={stop.town}
                      pickupStopId={stop.pickupStopId}
                    />
                  ))}
                </ol>
              </>
            )}
            {day ? <VehicleDayPanel routeId={route.id} day={day} readings={false} /> : null}
          </section>
        ))
      )}
    </div>
  );
}
