/**
 * Fair comparisons of the headline (KPI-07). Pure.
 *
 * A day is compared with the same weekday of the week before and with the
 * four same weekdays before it (their counters summed: a rate over the four
 * weeks). A day done compares its realized figures with those days' realized
 * figures; a day planned compares its plan with their validated plans, as
 * frozen at the validation (their current routes when none was frozen).
 */
import { summarizePeriod, type DayKpis, type PeriodKpis } from "./kpis";
import { addPlanFigures, comparisonDates, emptyPlanFigures, planFiguresOf, type PlanFigures } from "./kpis-plan";

export type RealizedComparison = {
  /** The same weekday a week before, when it had routes. */
  previous: DayKpis | null;
  /** The four same weekdays before that had routes, summed; null when none had. */
  fourWeeks: (PeriodKpis & { count: number }) | null;
};

/** The days the comparisons of `date` read. */
export function comparisonDays(date: string, lookup: ReadonlyMap<string, DayKpis>): DayKpis[] {
  return comparisonDates(date).flatMap((d) => {
    const day = lookup.get(d);
    return day && day.vehicles > 0 ? [day] : [];
  });
}

export function realizedComparison(date: string, lookup: ReadonlyMap<string, DayKpis>): RealizedComparison {
  const [weekBefore] = comparisonDates(date);
  const previous = weekBefore ? (lookup.get(weekBefore) ?? null) : null;
  const days = comparisonDays(date, lookup).sort((a, b) => a.date.localeCompare(b.date));
  return {
    previous: previous && previous.vehicles > 0 ? previous : null,
    fourWeeks: days.length > 0 ? { ...summarizePeriod(days), count: days.length } : null,
  };
}

/** The plan of a day: as validated (frozen) for a day already started, else its routes as they stand. */
export type PlanView = { date: string; figures: PlanFigures; frozen: boolean; validatedAt: Date | null };

export function planViewOf(day: DayKpis, today: string): PlanView | null {
  if (day.date <= today && day.frozen) {
    return { date: day.date, figures: day.frozen.figures, frozen: true, validatedAt: day.frozen.validatedAt };
  }
  if (day.vehicles === 0) return null;
  return { date: day.date, figures: planFiguresOf(day), frozen: false, validatedAt: day.validatedAt };
}

export type PlannedComparison = {
  previous: PlanView | null;
  fourWeeks: { figures: PlanFigures; count: number; frozen: number } | null;
};

export function plannedComparison(date: string, lookup: ReadonlyMap<string, DayKpis>, today: string): PlannedComparison {
  const views = comparisonDates(date).map((d) => {
    const day = lookup.get(d);
    return day ? planViewOf(day, today) : null;
  });
  const known = views.filter((v): v is PlanView => v !== null);
  return {
    previous: views[0] ?? null,
    fourWeeks:
      known.length > 0
        ? {
            figures: known.reduce((sum, v) => addPlanFigures(sum, v.figures), emptyPlanFigures()),
            count: known.length,
            frozen: known.filter((v) => v.frozen).length,
          }
        : null,
  };
}
