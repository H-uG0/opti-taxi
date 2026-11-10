/**
 * Wording of the tariff coverage alerts of /tarifs (lib/domain/tariffs.ts
 * tariffCoverageAlerts). Pure module, unit-tested.
 */
import type { TariffCoverageAlert } from "@/lib/domain/tariffs";
import { VEHICLE_TYPE_SHORT } from "@/lib/labels";
import { formatShortDate } from "@/lib/time";
import { ALL_ZONES } from "../vehicules/_lib/departments";

/** Days after tomorrow checked by /tarifs: tomorrow and the 7 following days. */
export const COVERAGE_DAYS = 7;

/** "VSL 04", "Taxi toutes zones", plus the grid's own label. */
function gridName(alert: Pick<TariffCoverageAlert, "vehicleType">, grid: NonNullable<TariffCoverageAlert["expiring"]>): string {
  const zone = grid.department === ALL_ZONES ? "toutes zones" : grid.department;
  return `${VEHICLE_TYPE_SHORT[alert.vehicleType]} ${zone}${grid.label ? ` «\u202f${grid.label}\u202f»` : ""}`;
}

/**
 * "La grille VSL 04 expire le 30/11/2026 : aucune ne prend le relais.",
 * "Aucune grille en vigueur le 10/11/2026 ; la prochaine ne commence que le 13/11/2026."
 */
export function coverageAlertText(alert: TariffCoverageAlert): string {
  const resumes = alert.resumesOn ? `la prochaine ne commence que le ${formatShortDate(alert.resumesOn)}` : null;
  if (alert.kind === "expires" && alert.expiring) {
    const ends = `La grille ${gridName(alert, alert.expiring)} expire le ${formatShortDate(alert.expiring.validTo)}`;
    return resumes ? `${ends} et ${resumes}.` : `${ends}\u00a0: aucune ne prend le relais.`;
  }
  const missing = `Aucune grille en vigueur le ${formatShortDate(alert.uncoveredFrom)}`;
  return resumes ? `${missing}\u202f; ${resumes}.` : `${missing}.`;
}
