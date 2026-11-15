import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { coursesHref, EMPTY_FILTERS } from "../courses/trip-list";
import { dashboardHref } from "../tableau-de-bord/query";
import { entryRateText, type DayClosing } from "@/lib/planning/day-closing";
import { pluralize } from "@/lib/planning/format";
import { planningTripHref } from "@/lib/planning/links";
import { formatDayDate, formatMinute } from "@/lib/time";

/** People listed under the rate at most (the lowest rates first): the dashboard gives everyone. */
const PEOPLE_SHOWN = 6;
/** Trips listed at most: the count says how many there are. */
const TRIPS_SHOWN = 30;

/**
 * The trips of a day whose outcome the crews never recorded (FLD-02), on the planning of today for the day before and
 * on a past day's planning for that day: the day's entry rate and each person's below 100 %, the same rate as the
 * dashboard's « Saisie des statuts » (link to its « Personnel » breakdown), and each trip to open on its day's
 * planning, where « Corriger un statut » records the real time with a reason; past the first TRIPS_SHOWN, all of them
 * in Courses (filter « Non clôturées »). Nothing when every outcome is recorded. On today's planning the day is the
 * last one with routes (a Monday shows Saturday's), « hier » only when it is the day before.
 */
export function DayClosingNotice({
  closing,
  fromToday,
  yesterday,
}: {
  closing: DayClosing;
  /** Shown on today's planning (an earlier day's trips), not on that day's own planning. */
  fromToday: boolean;
  /** The day is the day before today (« hier »). */
  yesterday: boolean;
}) {
  if (closing.unclosed.length === 0) return null;
  const day = fromToday && yesterday ? "hier" : `le ${formatDayDate(closing.date)}`;
  const behind = closing.people.filter((person) => person.recorded < person.placed).slice(0, PEOPLE_SHOWN);
  const shown = closing.unclosed.slice(0, TRIPS_SHOWN);
  return (
    <details data-wall-hide className="group rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-950">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 focus-visible:outline-2 focus-visible:outline-brand-600 [&::-webkit-details-marker]:hidden">
        <ClipboardCheck aria-hidden className="size-4 shrink-0" />
        <span className="font-semibold">
          {pluralize(closing.unclosed.length, "course non clôturée", "courses non clôturées")} {day}
        </span>
        <span className="tabular">
          · statuts saisis {entryRateText(closing)} ({closing.recorded}/{closing.placed})
        </span>
        <span className="ml-auto text-xs font-medium underline underline-offset-2 group-open:hidden">Voir</span>
      </summary>
      <div className="space-y-2 border-t border-amber-200 px-3 py-2">
        {behind.length > 0 ? (
          <p>
            <span className="font-medium">Saisie par personne&nbsp;: </span>
            {behind.map((person) => `${person.name} ${entryRateText(person)}`).join(" · ")}
            {" · "}
            <Link
              href={dashboardHref({ tab: "ventilation", from: closing.date, to: closing.date, axis: "chauffeur", sort: "saisie" })}
              className="font-medium underline underline-offset-2"
            >
              Tout le personnel
            </Link>
          </p>
        ) : null}
        <p className="text-xs">
          Aucun «&#x202F;Déposé&#x202F;» ni «&#x202F;Patient absent&#x202F;» saisi. Ouvrez la course, puis «&#x202F;Corriger un statut&#x202F;» avec
          l&apos;heure réelle et un motif.
          {fromToday && yesterday ? " L'équipage a pu saisir jusqu'à 03:00 ce matin («\u202fFin de tournée\u202f»)." : null}
        </p>
        <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((trip) => (
            <li key={trip.tripId}>
              <Link href={planningTripHref(closing.date, trip.tripId)} className="hover:underline">
                <span className="font-medium">{trip.vehicleLabel}</span>
                <span className="tabular"> · {formatMinute(trip.plannedPickupMinute)}</span> · {trip.patientName}
                <span className="text-amber-800"> · {trip.onBoard ? "pris en charge, dépose non saisie" : "aucun statut"}</span>
              </Link>
            </li>
          ))}
        </ul>
        {closing.unclosed.length > shown.length ? (
          <p className="text-xs">
            …{" "}
            <Link href={coursesHref(closing.date, { ...EMPTY_FILTERS, status: "UNCLOSED" })} className="font-medium underline underline-offset-2">
              et {closing.unclosed.length - shown.length} de plus&nbsp;: toutes les courses non clôturées dans Courses
            </Link>
          </p>
        ) : null}
      </div>
    </details>
  );
}
