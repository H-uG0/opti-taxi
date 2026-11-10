/**
 * Notice of the fleet screens: upcoming routes still using a deactivated
 * vehicle or driver. No hooks: usable from server and client components.
 */
import Link from "next/link";
import { Notice } from "@/components/ui/notice";
import { formatShortDate } from "@/lib/time";
import { upcomingRouteDates, upcomingRoutesNotice, type UpcomingRoute } from "./upcoming-routes";

const MAX_PLANNING_LINKS = 10;

/**
 * Upcoming routes still using a deactivated vehicle or driver, with a link to
 * the planning of each day so the regulator can re-run the optimisation.
 */
export function UpcomingRoutesCallout({
  routes,
  subject,
  className,
}: {
  routes: readonly UpcomingRoute[];
  subject: "vehicle" | "driver";
  className?: string;
}) {
  const notice = upcomingRoutesNotice(routes, subject);
  if (!notice) return null;
  const dates = upcomingRouteDates(routes).slice(0, MAX_PLANNING_LINKS);
  return (
    <Notice tone="warning" title="Tournées à replanifier" className={className}>
      <p>{notice}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {dates.map((date) => (
          <li key={date}>
            <Link
              href={`/planning?date=${date}`}
              className="rounded-sm font-medium underline underline-offset-2 hover:text-amber-950 focus-visible:outline-2 focus-visible:outline-amber-600"
            >
              Planning du <span className="tabular">{formatShortDate(date)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
