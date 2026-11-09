import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import type { MissingRecurrence } from "@/lib/trips/missing";

/** Names of the first entries, "et N autres" beyond. */
function names(list: readonly MissingRecurrence[], max = 4): string {
  const shown = list.slice(0, max).map((r) => `${r.patientName} (${r.label})`);
  const more = list.length - shown.length;
  return more > 0 ? `${shown.join(", ")} et ${more} autre${more > 1 ? "s" : ""}` : shown.join(", ");
}

/**
 * « N récurrences actives sans course ce jour » : before optimizing, the
 * regular patients the day would leave out — no valid prescription, or trips
 * not generated yet (created when the page opens, within the horizon).
 */
export function MissingRecurrencesNote({ missing, completing }: { missing: readonly MissingRecurrence[]; completing: boolean }) {
  if (missing.length === 0) return null;
  const withoutPrescription = missing.filter((r) => r.withoutPrescription);
  const notGenerated = missing.filter((r) => !r.withoutPrescription);
  return (
    <div role="note" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
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
            Courses pas encore générées : {names(notGenerated)}.{" "}
            {completing ? "Création en cours…" : "Utilisez « Générer les courses de la semaine » dans Courses, ou saisissez-les."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
