import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CalendarClock, CalendarRange, CalendarX } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { PASSWORD_PAGE, requireDriver } from "@/lib/auth";
import { cn } from "@/components/ui/cn";
import { formatLongDate, formatMinute, minuteOfDay, todayIso, tomorrowIso } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { STOP_KIND_LABELS } from "@/lib/labels";
import type { RegulatorContact } from "./_lib/links";
import {
  loadDriverRoutes,
  loadEndOfRouteRoutes,
  loadFieldContext,
  loadNextDaySummary,
  loadNextRouteSummary,
  loadNoShowMinWait,
  loadRegulatorContact,
  loadReturnTripsAfterOutboundNoShow,
  loadVehicleDays,
} from "./_lib/load";
import { isReadableRoadmapDate, type NextDaySummary } from "./_lib/roadmap";
import { buildRouteView, nextDayCardFirst, NO_FIELD_CONTEXT, type RouteView } from "./_lib/view";
import { parseDriverTheme, THEME_COOKIE } from "./_lib/theme";
import { InstallHelp } from "./_components/install-help";
import { NextStopBar, type BarStop } from "./_components/next-stop-bar";
import { ThemeSwitch } from "./_components/theme-switch";
import { lateEntryDates } from "./_lib/access";
import { endOfRouteView, forgottenStops } from "./_lib/end-of-route";
import { DaySwitch } from "./_components/day-switch";
import { RefreshControl } from "./_components/refresh-control";
import { ServerRenderMark } from "./_components/driver-app";
import { SessionLine } from "./_components/field-status";
import { RegulatorCallBlock } from "./_components/regulator-call";
import { RoadmapChangeBanner, RoadmapWatchProvider } from "./_components/roadmap-watch";
import { RouteSection } from "./_components/route-section";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const bigLink =
  "inline-flex min-h-12 touch-manipulation items-center justify-center rounded-xl px-6 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

type NextRoute = Awaited<ReturnType<typeof loadNextRouteSummary>>;

/**
 * « Prochaine tournée » (FLD-04): beyond tomorrow, the crew's next route at a glance — its day, start, depot and
 * vehicle. No stop and no patient: the roadmap of that day opens the evening before.
 */
function NextRouteCard({ route }: { route: NonNullable<NextRoute> }) {
  return (
    <section aria-labelledby="next-route-title" className="space-y-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-left">
      <h2 id="next-route-title" className="flex items-center gap-2 text-base font-bold text-slate-950">
        <CalendarRange aria-hidden className="size-5 shrink-0 text-brand-700" />
        <span className="first-letter:uppercase">Prochaine tournée&nbsp;: {formatLongDate(route.date)}</span>
      </h2>
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
        {route.vehicleLabel}
        {route.status === "VALIDATED" ? <Badge tone="success">Validée</Badge> : <Badge tone="warning">Provisoire</Badge>}
      </p>
      <p className="text-base text-slate-800">
        Embauche à <span className="tabular font-semibold">{formatMinute(route.startMinute)}</span>, départ du dépôt {route.depotName}.
      </p>
      <p className="text-sm text-slate-600">Le détail des arrêts s&apos;ouvre la veille, dans l&apos;onglet «&#x202F;Demain&#x202F;».</p>
    </section>
  );
}

function NoRoute({
  date,
  tomorrow,
  regulator,
  nextRoute,
}: {
  date: string;
  tomorrow: string;
  regulator: RegulatorContact | null;
  nextRoute: NextRoute;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center">
      <CalendarX aria-hidden className="mx-auto size-10 text-slate-400" />
      <p className="mt-3 text-lg font-semibold text-slate-900">Aucune tournée {date === tomorrow ? "demain" : "aujourd'hui"}</p>
      <p className="mt-1 text-sm text-slate-600">
        {date === tomorrow
          ? "La tournée de demain n'est pas encore planifiée. Revenez plus tard ou appelez la régulation."
          : "Aucune course ne vous est affectée ce jour-là. En cas de doute, appelez la régulation."}
      </p>
      {date === tomorrow && nextRoute ? (
        <div className="mt-5">
          <NextRouteCard route={nextRoute} />
        </div>
      ) : null}
      <RegulatorCallBlock regulator={regulator} className="mt-5" />
      <div className="mt-3 flex justify-center">
        {date === tomorrow ? (
          <Link href="/chauffeur" className={cn(bigLink, "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50")}>
            Revenir à aujourd&apos;hui
          </Link>
        ) : (
          <Link href={`/chauffeur?date=${tomorrow}`} className={cn(bigLink, "bg-brand-700 text-white hover:bg-brand-800")}>
            Voir demain
          </Link>
        )}
      </div>
    </div>
  );
}

/** Tomorrow at a glance on today's roadmap (DAY-04): when the crew starts and its first stop, no patient named. */
function NextDayCard({ tomorrow, routes }: { tomorrow: string; routes: NextDaySummary[] }) {
  if (routes.length === 0) return null;
  return (
    <section aria-labelledby="next-day-title" className="space-y-3 rounded-2xl border border-slate-300 bg-white px-4 py-3">
      <h2 id="next-day-title" className="flex items-center gap-2 text-base font-bold text-slate-950 first-letter:uppercase">
        <CalendarClock aria-hidden className="size-5 shrink-0 text-brand-700" />
        Demain, {formatLongDate(tomorrow)}
      </h2>
      {routes.map((route) => (
        <div key={route.id} className="space-y-2">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
            {route.vehicleLabel}
            {route.status === "VALIDATED" ? <Badge tone="success">Validée</Badge> : <Badge tone="warning">Provisoire</Badge>}
          </p>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200">
            <div className="bg-white px-3 py-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Embauche</dt>
              <dd className="tabular text-lg font-semibold text-slate-900">{formatMinute(route.startMinute)}</dd>
              <dd className="text-sm text-slate-600">Départ du dépôt {route.depotName}</dd>
            </div>
            <div className="bg-white px-3 py-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Premier arrêt</dt>
              {route.firstStop ? (
                <>
                  <dd className="tabular text-lg font-semibold text-slate-900">{formatMinute(route.firstStop.minute)}</dd>
                  <dd className="text-sm text-slate-600">
                    {STOP_KIND_LABELS[route.firstStop.kind]}
                    {route.firstStop.town ? `, ${route.firstStop.town}` : ""}
                  </dd>
                </>
              ) : (
                <dd className="text-sm text-slate-600">Aucun arrêt</dd>
              )}
            </div>
          </dl>
        </div>
      ))}
      <Link
        href={`/chauffeur?date=${tomorrow}`}
        prefetch={false}
        className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-800 underline underline-offset-2"
      >
        Voir la tournée de demain
      </Link>
    </section>
  );
}

/** Before 03:00, the day before still has stops without a status: « Fin de tournée » of yesterday (FLD-02). */
function YesterdayNotice({ date, forgotten }: { date: string; forgotten: number }) {
  if (forgotten === 0) return null;
  return (
    <Link
      href={`/chauffeur/fin-de-tournee?date=${date}`}
      prefetch={false}
      className="flex min-h-12 items-center gap-2 rounded-xl border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-brand-600"
    >
      <span>
        <span className="font-semibold">Hier, {forgotten > 1 ? `${forgotten} arrêts` : "1 arrêt"} sans statut.</span> Saisissez l&apos;heure réelle avant 03:00 dans
        «&#x202F;Fin de tournée&#x202F;».
      </span>
    </Link>
  );
}

function DayNotice({ date, today }: { date: string; today: string }) {
  if (date === today) return null;
  return (
    <p className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950">
      Aperçu&nbsp;: les statuts «&#x202F;pris en charge&#x202F;» et «&#x202F;déposé&#x202F;» se saisissent le jour de la tournée.
    </p>
  );
}

/**
 * The stops the bottom bar walks through (FLD-04): the stops still to do of today's first route under way, in order.
 * « Appeler »: the reception at a care place, else the patient, else the regulation.
 */
function barStopsOf(views: readonly RouteView[], regulator: RegulatorContact | null): BarStop[] {
  const route = views.find((view) => view.nextStop !== null);
  if (!route) return [];
  return route.stops
    .filter((stop) => stop.state === "pending")
    .map((stop) => ({
      id: stop.id,
      kind: stop.kind,
      plannedMinute: stop.plannedMinute,
      patient: stop.patient,
      primary: stop.controls.primary,
      pickupStopId: stop.pickupStopId,
      blocked: stop.controls.blockedReason !== null,
      lat: stop.lat,
      lng: stop.lng,
      call: stop.facility?.phoneHref
        ? { href: stop.facility.phoneHref, label: "l'accueil" }
        : stop.phoneHref
          ? { href: stop.phoneHref, label: "le patient" }
          : regulator
            ? { href: regulator.href, label: "la régulation" }
            : null,
    }));
}

export default async function DriverRoadmapPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireDriver();
  const params = await searchParams;
  const now = new Date();
  const today = todayIso(now);
  const tomorrow = tomorrowIso(now);
  // Only today and tomorrow can be opened (patient data minimisation, see
  // roadmapDateWindow); any other ?date= goes back to today's roadmap.
  // « Demain » of the manifest's shortcuts (FLD-04): a fixed address for tomorrow's roadmap.
  if (params.jour === "demain") redirect(`/chauffeur?date=${tomorrow}`);
  const requested = typeof params.date === "string" ? params.date : null;
  if (params.date !== undefined && !isReadableRoadmapDate(requested, today)) redirect("/chauffeur");
  const date = requested ?? today;
  // Statuses are recorded on the service day only (the status route handler checks it too).
  const editable = date === today;

  const [routes, regulator, noShowMinWait] = await Promise.all([
    loadDriverRoutes(user.driverId, date, today),
    loadRegulatorContact(),
    loadNoShowMinWait(),
    // Trace of the read (patient names, phones and addresses on screen) for the day shown,
    // tomorrow on the ?date= preview; never breaks the page.
    auditRead(user, { action: "roadmap.view", entity: "Driver", entityId: user.driverId, serviceDate: date }),
  ]);
  // Before 03:00, the day before is still open to its forgotten statuses (« Fin de tournée »).
  const openDays = lateEntryDates(now);
  const yesterday = editable && openDays.length > 1 ? openDays[0]! : null;
  const [afterOutboundNoShow, field, nextDay, yesterdayRoutes, vehicleDays, jar] = await Promise.all([
    loadReturnTripsAfterOutboundNoShow(routes, date),
    // Signals and requests of the crew (DAY-05): the patients' returns and what was already sent, today only.
    editable ? loadFieldContext(routes, date) : NO_FIELD_CONTEXT,
    // The evening before: tomorrow's start and first stop (DAY-04).
    date === today ? loadNextDaySummary(user.driverId, tomorrow) : [],
    yesterday ? loadEndOfRouteRoutes(user.driverId, yesterday, now) : [],
    // The day's vehicle: its odometer readings and the last mileage known (FLD-03), today only.
    editable ? loadVehicleDays(routes, date) : new Map(),
    cookies(),
  ]);
  // Beyond tomorrow (FLD-04): the next route when none is planned tomorrow, without any patient data.
  const nextRoute = nextDay.length === 0 || (date === tomorrow && routes.length === 0) ? await loadNextRouteSummary(user.driverId, tomorrow) : null;
  const theme = parseDriverTheme(jar.get(THEME_COOKIE)?.value);
  const yesterdayForgotten = yesterdayRoutes.reduce((sum, route) => sum + endOfRouteView(route.stops).pending.length, 0);
  const nowMinute = minuteOfDay(now);
  const views = routes.map((route) => buildRouteView(route, user.driverId, editable, afterOutboundNoShow, field, noShowMinWait));
  // Tomorrow's card, once: first in the evening (today's stops done, or no route today), after the routes otherwise.
  const nextDayCard =
    nextDay.length > 0 ? <NextDayCard tomorrow={tomorrow} routes={nextDay} /> : date === today && nextRoute ? <NextRouteCard route={nextRoute} /> : null;
  // The bottom bar (FLD-04): the next stop of today's first route still under way.
  const barStops = editable ? barStopsOf(views, regulator) : [];
  const nextDayFirst = nextDayCardFirst(views);

  return (
    // Changes made by the regulation since the crew last looked (DAY-04): banner, highlighted stops, « J'ai vu ».
    <RoadmapWatchProvider date={date} routes={views.map((view) => ({ vehicleId: view.vehicleId, fingerprint: view.fingerprint }))}>
      <div className="space-y-4">
        {/* Statuses sent before this render are now shown by the page itself. */}
        <ServerRenderMark at={now.getTime()} />
        <DaySwitch date={date} today={today} tomorrow={tomorrow} />
        <InstallHelp />

        <div className="space-y-2">
          <h1 className="text-xl font-bold text-slate-950 first-letter:uppercase">{formatLongDate(date)}</h1>
          <DayNotice date={date} today={today} />
          {yesterday ? <YesterdayNotice date={yesterday} forgotten={yesterdayForgotten} /> : null}
          <RefreshControl renderedAt={formatMinute(minuteOfDay(new Date()))} />
        </div>

        <RoadmapChangeBanner labels={Object.fromEntries(views.map((view) => [view.vehicleId, view.vehicle.label]))} />
        {nextDayFirst ? nextDayCard : null}

        {views.length === 0 ? (
          <NoRoute date={date} tomorrow={tomorrow} regulator={regulator} nextRoute={nextRoute} />
        ) : (
          <div className="space-y-8">
            {views.map((view) => (
              <RouteSection
                key={view.id}
                route={view}
                regulator={regulator}
                vehicleDay={vehicleDays.get(view.id) ?? null}
                endOfRoute={
                  editable
                    ? {
                        forgotten: forgottenStops(
                          view.stops.filter((stop) => stop.state === "pending"),
                          nowMinute,
                        ),
                      }
                    : null
                }
              />
            ))}
            {nextDayFirst ? null : nextDayCard}
          </div>
        )}

        <div className="space-y-1 border-t border-slate-200 pt-3 text-center">
          <SessionLine />
          <ThemeSwitch initial={theme} />
          <Link
            href={PASSWORD_PAGE}
            className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900"
          >
            Changer mon mot de passe
          </Link>
        </div>
        {barStops.length > 0 ? (
          <>
            {/* Room under the last card for the bar fixed at the bottom. */}
            <div aria-hidden className="h-32" />
            <NextStopBar stops={barStops} autoScroll={views.some((view) => view.nextStop !== null && view.progress.closed > 0)} />
          </>
        ) : null}
      </div>
    </RoadmapWatchProvider>
  );
}
