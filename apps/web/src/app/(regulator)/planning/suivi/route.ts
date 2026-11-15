/**
 * GET /planning/suivi?date=YYYY-MM-DD: the live state of a planned day (lib/planning/live-load.ts), polled every
 * 30 s by the planning page of today while it is on screen (« Suivi du jour », DAY-01): the statuses the crews
 * recorded, the ends of session they signalled, the roadmaps they saw, their requests, and a key of the plan that
 * moves when anything else changed it (« Recharger »).
 *
 * A few indexed reads per poll and no write. Ids, minutes, statuses, crew names and a request's reason from a fixed
 * list: the poll extends the page's read of the day, traced once with it (plan.view), not at every poll. Today only,
 * the one date the page follows: no other day is read through it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadLiveSnapshot } from "@/lib/planning/live-load";
import { isIsoDate, todayIso } from "@/lib/time";

export async function GET(request: NextRequest) {
  await requireUser("REGULATOR");
  const date = request.nextUrl.searchParams.get("date");
  if (!isIsoDate(date)) return NextResponse.json({ error: "Date invalide." }, { status: 400 });
  if (date !== todayIso()) return NextResponse.json({ error: "Suivi du jour\u00a0: aujourd'hui seulement." }, { status: 400 });
  return NextResponse.json(await loadLiveSnapshot(db, date), { headers: { "Cache-Control": "no-store" } });
}
