import { Badge } from "@/components/ui/badge";

/** « Journée simulée »: a date produced by the history simulation of the demonstration data (lib/simulated.ts). */
export function SimulatedDayBadge() {
  return (
    <Badge tone="simulated">
      <span title="Journée simulée pour la démonstration : données fictives, statuts, réponses et retards simulés">Journée simulée</span>
    </Badge>
  );
}
