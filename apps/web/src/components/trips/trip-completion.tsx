"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { completeDayTrips } from "@/app/(regulator)/courses/actions";
import type { MissingRecurrence } from "@/lib/trips/missing";
import { MissingRecurrencesNote, type GenerationState } from "./missing-recurrences";

/**
 * Once the page is shown, completes the recurring trips of `date` (a date of
 * the horizon) and refreshes the page when trips were created or brought
 * back. The server component never writes: this is the page's only write.
 * Shows the « récurrences actives sans course ce jour » note of `missing`
 * with where the creation stands: in progress, failed, or done.
 */
export function TripCompletion({
  date,
  missing,
  onCourses = false,
  className,
}: {
  date: string;
  missing: readonly MissingRecurrence[];
  onCourses?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<GenerationState>("pending");
  useEffect(() => {
    let current = true;
    completeDayTrips(date)
      .then((result) => {
        if (!current) return;
        // A failure leaves the trips as they are: the day is completed again at the next opening or optimization.
        setState(result.failed ? "failed" : "done");
        if (result.changed) router.refresh();
      })
      .catch(() => {
        if (current) setState("failed");
      });
    return () => {
      current = false;
    };
  }, [date, router]);
  return <MissingRecurrencesNote missing={missing} state={state} onCourses={onCourses} className={className} />;
}
