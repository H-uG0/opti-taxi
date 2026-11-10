import Link from "next/link";
import { BadgeEuro } from "lucide-react";
import type { TariffGap } from "@/lib/domain/tariffs";
import { tariffGapList } from "@/lib/planning/format";
import { formatLongDate } from "@/lib/time";

/** Available vehicles without tariff grid on the planned date: their revenue is estimated at 0 €. */
export function TariffGapBanner({ gaps, date }: { gaps: TariffGap[]; date: string }) {
  if (gaps.length === 0) return null;
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
      <BadgeEuro aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 break-words">
        <span className="font-semibold">Aucune grille tarifaire en vigueur le {formatLongDate(date)}</span> pour{" "}
        {tariffGapList(gaps)}. Leur chiffre d&apos;affaires est estimé à 0&nbsp;€, ce qui fausse la marge et le choix des
        tournées.{" "}
        <Link href="/tarifs" className="font-medium underline underline-offset-2">
          Grilles tarifaires
        </Link>
      </p>
    </div>
  );
}
