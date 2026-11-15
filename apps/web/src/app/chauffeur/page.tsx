import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarClock, CalendarX } from "lucide-react";
import { auditRead } from "@/lib/audit";
import { PASSWORD_PAGE, requireDriver } from "@/lib/auth";
import { cn } from "@/components/ui/cn";
import { formatLongDate, formatMinute, minuteOfDay, todayIso, tomorrowIso } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { STOP_KIND_LABELS } from "@/lib/labels";
import type { RegulatorContact } from "./_lib/links";
import {
  loadDriverRoutes,
  loadFieldContext,
  loadNextDaySummary,
  loadNoShowMinWait,
  loadRegulatorContact,
  loadReturnTripsAfterOutboundNoShow,
} from "./_lib/load";
import { isReadableRoadmapDate, type NextDaySummary } from "./_lib/roadmap";
import { buildRouteView, nextDayCardFirst, NO_FIELD_CONTEXT } from "./_lib/view";
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

function NoRoute({ date, tomorrow, regulator }: { date: string; tomorrow: string; regulator: RegulatorContact | null }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center">
      <CalendarX aria-hidden className="mx-auto size-10 text-slate-400" />
      <p className="mt-3 text-lg font-semibold text-slate-900">Aucune tournée {date === tomorrow ? "demain" : "aujourd'hui"}</p>
      <p className="mt-1 text-sm text-slate-600">
        {date === tomorrow
          ? "La tournée de demain n'est pas encore planifiée. Revenez plus tard ou appelez la régulation."
          : "Aucune course ne vous est affectée ce jour-là. En cas de doute, appelez la régulation."}
      </p>
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

function DayNotice({ date, today }: { date: string; today: string }) {
  if (date === today) return null;
  return (
    <p className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950">
      Aperçu&nbsp;: les statuts «&#x202F;pris en charge&#x202F;» et «&#x202F;déposé&#x202F;» se saisissent le jour de la tournée.
    </p>
  );
}

export default async function DriverRoadmapPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireDriver();
  const params = await searchParams;
  const now = new Date();
  const today = todayIso(now);
  const tomorrow = tomorrowIso(now);
  // Only today and tomorrow can be opened (patient data minimisation, see
  // roadmapDateWindow); any other ?date= goes back to today's roadmap.
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
  const [afterOutboundNoShow, field, nextDay] = await Promise.all([
    loadReturnTripsAfterOutboundNoShow(routes, date),
    // Signals and requests of the crew (DAY-05): the patients' returns and what was already sent, today only.
    editable ? loadFieldContext(routes, date) : NO_FIELD_CONTEXT,
    // The evening before: tomorrow's start and first stop (DAY-04).
    date === today ? loadNextDaySummary(user.driverId, tomorrow) : [],
  ]);
  const views = routes.map((route) => buildRouteView(route, user.driverId, editable, afterOutboundNoShow, field, noShowMinWait));
  // Tomorrow's card, once: first in the evening (today's stops done, or no route today), after the routes otherwise.
  const nextDayCard = <NextDayCard tomorrow={tomorrow} routes={nextDay} />;
  const nextDayFirst = nextDayCardFirst(views);

  return (
    // Changes made by the regulation since the crew last looked (DAY-04): banner, highlighted stops, « J'ai vu ».
    <RoadmapWatchProvider date={date} routes={views.map((view) => ({ vehicleId: view.vehicleId, fingerprint: view.fingerprint }))}>
      <div className="space-y-4">
        {/* Statuses sent before this render are now shown by the page itself. */}
        <ServerRenderMark at={now.getTime()} />
        <DaySwitch date={date} today={today} tomorrow={tomorrow} />

        <div className="space-y-2">
          <h1 className="text-xl font-bold text-slate-950 first-letter:uppercase">{formatLongDate(date)}</h1>
          <DayNotice date={date} today={today} />
          <RefreshControl renderedAt={formatMinute(minuteOfDay(new Date()))} />
        </div>

        <RoadmapChangeBanner labels={Object.fromEntries(views.map((view) => [view.vehicleId, view.vehicle.label]))} />
        {nextDayFirst ? nextDayCard : null}

        {views.length === 0 ? (
          <NoRoute date={date} tomorrow={tomorrow} regulator={regulator} />
        ) : (
          <div className="space-y-8">
            {views.map((view) => (
              <RouteSection key={view.id} route={view} regulator={regulator} />
            ))}
            {nextDayFirst ? null : nextDayCard}
          </div>
        )}

        <div className="space-y-1 border-t border-slate-200 pt-3 text-center">
          <SessionLine />
          <Link
            href={PASSWORD_PAGE}
            className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900"
          >
            Changer mon mot de passe
          </Link>
        </div>
      </div>
    </RoadmapWatchProvider>
  );
}
