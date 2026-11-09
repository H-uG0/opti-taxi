/**
 * GET /planning/version?date=YYYY-MM-DD: version of the date's plan and
 * whether a computation of it is running (lib/planning/version.ts). Polled
 * by the planning page while a computation runs and when its tab becomes
 * visible again, to offer « Recharger » when the plan changed elsewhere.
 *
 * Cheap and silent: one aggregate query and two single-row reads, no patient
 * data in the answer (opaque tokens and a flag), hence no audit event per
 * poll (the page itself records plan.view).
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadDayVersion } from "@/lib/planning/version";
import { isIsoDate } from "@/lib/time";

export async function GET(request: NextRequest) {
  await requireUser("REGULATOR");
  const date = request.nextUrl.searchParams.get("date");
  if (!isIsoDate(date)) return NextResponse.json({ error: "Date invalide." }, { status: 400 });
  return NextResponse.json(await loadDayVersion(db, date), { headers: { "Cache-Control": "no-store" } });
}
