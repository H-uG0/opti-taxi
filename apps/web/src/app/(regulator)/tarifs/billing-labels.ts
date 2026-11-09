/**
 * French wording of the billing settings (Grilles tarifaires, « Règles de
 * facturation »). Pure module.
 */
import type { EmptyLegRule, SharedPatientCount, SurchargeOrder } from "@prisma/client";

export const EMPTY_LEG_LABELS: Record<EmptyLegRule, string> = {
  NONE: "Jamais (non modélisé)",
  DEPOT: "Aller qui termine la tournée, retour qui la commence (véhicule à vide jusqu'à la station)",
};

export const EMPTY_LEG_SHORT: Record<EmptyLegRule, string> = {
  NONE: "retour à vide non compté",
  DEPOT: "retour à vide en début ou fin de tournée",
};

export const SURCHARGE_ORDER_LABELS: Record<SurchargeOrder, string> = {
  MULTIPLICATIVE: "Multipliées (km × 1,5 × 1,5)",
  ADDITIVE: "Additionnées (km × (1 + 0,5 + 0,5))",
};

export const PATIENT_COUNT_LABELS: Record<SharedPatientCount, string> = {
  DISTINCT: "Patients distincts rencontrés à bord pendant le trajet",
  MAX_ON_BOARD: "Plus grand nombre de patients à bord en même temps",
};

export const PATIENT_COUNT_SHORT: Record<SharedPatientCount, string> = {
  DISTINCT: "patients distincts",
  MAX_ON_BOARD: "patients à bord en même temps",
};
