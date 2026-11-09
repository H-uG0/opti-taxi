"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { completeDayTrips } from "@/app/(regulator)/courses/actions";

/**
 * Once the page is shown, completes the recurring trips of `date` (a date of
 * the horizon) and refreshes the page when trips were created or brought
 * back. The server component never writes: this is the page's only write.
 */
export function TripCompletion({ date }: { date: string }) {
  const router = useRouter();
  useEffect(() => {
    let current = true;
    completeDayTrips(date)
      .then((result) => {
        if (current && result.changed) router.refresh();
      })
      // An error leaves the page as it is: the day is completed again at the next opening or optimization.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [date, router]);
  return null;
}
