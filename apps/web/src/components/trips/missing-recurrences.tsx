import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { MissingRecurrence } from "@/lib/trips/missing";

/** Names of the first entries, "et N autres" beyond. */
function names(list: readonly MissingRecurrence[], max = 4): string {
  const shown = list.slice(0, max).map((r) => `${r.patientName} (${r.label})`);
  const more = list.length - shown.length;
  return more > 0 ? `${shown.join(", ")} et ${more} autre${more > 1 ? "s" : ""}` : shown.join(", ");
}

/**
 * Where the trips not generated yet of the date stand:
 * - "pending": being created now (date of the horizon, page just shown);
 * - "failed": the creation failed (it is tried again at the next opening or optimization);
 * - "done": the creation ran, these trips were not created (generate the week or type them);
 * - "today": today is never completed (a day already begun): type them;
 * - "later": beyond the horizon: « Générer les courses de la semaine ».
 */
export type GenerationState = "pending" | "failed" | "done" | "today" | "later";

/** The generation state of a date shown before the completion has answered (see TripCompletion). */
export function generationStateOf(date: string, today: string, completing: boolean): GenerationState {
  if (completing) return "pending";
  return date === today ? "today" : "later";
}

function notGeneratedAdvice(state: GenerationState, onCourses: boolean): string {
  const generate = `« Générer les courses de la semaine »${onCourses ? "" : " dans Courses"}`;
  switch (state) {
    case "pending":
      return "Création en cours…";
    case "failed":
      return `La création a échoué : rechargez la page, ou utilisez ${generate}.`;
    case "today":
      return `Les courses du jour ne sont pas créées automatiquement : saisissez-les (« Nouvelle course »${onCourses ? "" : " dans Courses"}).`;
    case "done":
    case "later":
      return `Utilisez ${generate}, ou saisissez-les.`;
  }
}

/**
 * « N récurrences actives sans course ce jour » : before optimizing, the
 * regular patients the day would leave out — no valid prescription, or trips
 * not generated yet (created when the page opens, within the horizon).
 * `onCourses`: shown on the Courses page itself (no « dans Courses »).
 */
export function MissingRecurrencesNote({
  missing,
  state,
  onCourses = false,
  className,
}: {
  missing: readonly MissingRecurrence[];
  state: GenerationState;
  onCourses?: boolean;
  className?: string;
}) {
  if (missing.length === 0) return null;
  const withoutPrescription = missing.filter((r) => r.withoutPrescription);
  const notGenerated = missing.filter((r) => !r.withoutPrescription);
  return (
    <div
      role="note"
      className={cn("flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950", className)}
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-semibold">
          {missing.length > 1
            ? `${missing.length} récurrences actives sans course ce jour`
            : "1 récurrence active sans course ce jour"}
        </p>
        {withoutPrescription.length > 0 ? (
          <p>
            Sans prescription valide à cette date : {names(withoutPrescription)}.{" "}
            <Link href="/prescriptions" className="font-medium underline underline-offset-2">
              Voir les prescriptions à traiter
            </Link>
          </p>
        ) : null}
        {notGenerated.length > 0 ? (
          <p>
            Courses pas encore générées : {names(notGenerated)}. {notGeneratedAdvice(state, onCourses)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
