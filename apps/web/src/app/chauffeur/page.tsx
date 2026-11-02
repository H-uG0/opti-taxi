import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarX } from "lucide-react";
import { requireDriver } from "@/lib/auth";
import { cn } from "@/components/ui/cn";
import { formatLongDate, formatMinute, minuteOfDay, todayIso, tomorrowIso } from "@/lib/time";
import { loadDriverRoutes, loadReturnTripsAfterOutboundNoShow } from "./_lib/load";
import { isReadableRoadmapDate } from "./_lib/roadmap";
import { buildRouteView } from "./_lib/view";
import { DaySwitch } from "./_components/day-switch";
import { RefreshControl } from "./_components/refresh-control";
import { RouteSection } from "./_components/route-section";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const bigLink =
  "inline-flex min-h-12 touch-manipulation items-center justify-center rounded-xl px-6 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

function NoRoute({ date, tomorrow }: { date: string; tomorrow: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center">
      <CalendarX aria-hidden className="mx-auto size-10 text-slate-400" />
      <p className="mt-3 text-lg font-semibold text-slate-900">Aucune tournée {date === tomorrow ? "demain" : "aujourd'hui"}</p>
      <p className="mt-1 text-sm text-slate-600">
        {date === tomorrow
          ? "La tournée de demain n'est pas encore planifiée. Revenez plus tard ou appelez la régulation."
          : "Aucune course ne vous est affectée ce jour-là. En cas de doute, appelez la régulation."}
      </p>
      <div className="mt-5 flex justify-center">
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

function DayNotice({ date, today }: { date: string; today: string }) {
  if (date === today) return null;
  return (
    <p className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950">
      Aperçu : les statuts « pris en charge » et « déposé » se saisissent le jour de la tournée.
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
  // Statuses are recorded on the service day only (the server actions check it too).
  const editable = date === today;

  const routes = await loadDriverRoutes(user.driverId, date, today);
  const afterOutboundNoShow = await loadReturnTripsAfterOutboundNoShow(routes, date);
  const views = routes.map((route) => buildRouteView(route, user.driverId, editable, afterOutboundNoShow));

  return (
    <div className="space-y-4">
      <DaySwitch date={date} today={today} tomorrow={tomorrow} />

      <div className="space-y-2">
        <h1 className="text-xl font-bold text-slate-950 first-letter:uppercase">{formatLongDate(date)}</h1>
        <DayNotice date={date} today={today} />
        <RefreshControl renderedAt={formatMinute(minuteOfDay(new Date()))} />
      </div>

      {views.length === 0 ? (
        <NoRoute date={date} tomorrow={tomorrow} />
      ) : (
        <div className="space-y-8">
          {views.map((view) => (
            <RouteSection key={view.id} route={view} />
          ))}
        </div>
      )}
    </div>
  );
}
