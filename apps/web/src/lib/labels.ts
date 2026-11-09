/** French UI labels for database enums. Keys mirror prisma/schema.prisma. */

export const VEHICLE_TYPE_LABELS = {
  TAXI: "Taxi",
  VSL: "VSL (« ambulance »)",
  AMBULANCE: "Ambulance (couché)",
} as const;

export const VEHICLE_TYPE_SHORT = {
  TAXI: "Taxi",
  VSL: "VSL",
  AMBULANCE: "Ambulance",
} as const;

export const PRESCRIBED_MODE_LABELS = {
  TAP: "Assis (taxi ou VSL)",
  AMBULANCE: "Allongé (ambulance)",
} as const;

export const MOBILITY_LABELS = {
  SEATED: "Assis",
  WHEELCHAIR: "Fauteuil roulant",
  LYING: "Allongé",
} as const;

export const SHARING_SCOPE_LABELS = {
  NONE: "Non autorisé",
  OUTBOUND: "Aller uniquement",
  RETURN: "Retour uniquement",
  BOTH: "Aller et retour",
} as const;

export const FACILITY_TYPE_LABELS = {
  HOSPITAL: "Hôpital (CHU / CH)",
  DIALYSIS: "Centre de dialyse",
  RADIOTHERAPY: "Radiothérapie",
  CHEMOTHERAPY: "Chimiothérapie",
  CLINIC: "Clinique",
  OTHER: "Autre",
} as const;

export const RECURRENCE_LEGS_LABELS = {
  OUTBOUND: "Aller seul",
  RETURN: "Retour seul",
  BOTH: "Aller et retour",
} as const;

export const DIRECTION_LABELS = {
  OUTBOUND: "Aller",
  RETURN: "Retour",
} as const;

export const TRIP_STATUS_LABELS = {
  PLANNED: "À planifier",
  ASSIGNED: "Planifiée",
  PICKED_UP: "Pris en charge",
  DROPPED_OFF: "Déposé",
  CANCELLED: "Annulée",
  NO_SHOW: "Absent",
} as const;

export const SHARING_STATUS_LABELS = {
  NOT_ELIGIBLE: "Non éligible",
  NOT_PROPOSED: "Non proposé",
  PROPOSED: "Proposé",
  ACCEPTED: "Accepté",
  REFUSED: "Refusé",
} as const;

export const PAYER_LABELS = {
  CPAM: "CPAM (prescription)",
  PRIVATE: "Client privé",
} as const;

export const QUALIFICATION_LABELS = {
  TAXI_CARD: "Carte professionnelle taxi",
  AUXILIARY: "Auxiliaire ambulancier",
  DEA: "Ambulancier DE",
} as const;

/** The person holding it, inside a sentence (« au moins un ambulancier DE »); the labels above are for badges and lists. */
export const QUALIFICATION_NOUNS = {
  TAXI_CARD: "titulaire de la carte professionnelle taxi",
  AUXILIARY: "auxiliaire ambulancier",
  DEA: "ambulancier DE",
} as const;

/** Motifs d'indisponibilité d'une personne (StaffAbsence.kind). */
export const ABSENCE_KIND_LABELS = {
  LEAVE: "Congé",
  SICK: "Arrêt maladie",
  TRAINING: "Formation",
  ON_CALL: "Garde",
  OTHER: "Absence",
} as const;

/** Motifs d'indisponibilité d'un véhicule (VehicleUnavailability.kind). */
export const VEHICLE_UNAVAILABILITY_LABELS = {
  MAINTENANCE: "Entretien",
  REPAIR: "Réparation",
  INSPECTION: "Contrôle technique",
  ON_CALL: "Garde",
  OTHER: "Indisponible",
} as const;

/** Échéances d'un véhicule (MaintenanceDeadline.kind). */
export const MAINTENANCE_KIND_LABELS = {
  INSPECTION: "Contrôle technique",
  SERVICE: "Révision",
  TIRES: "Pneumatiques",
  INSURANCE: "Assurance",
  OTHER: "Autre échéance",
} as const;

export const ENERGY_LABELS = {
  DIESEL: "Diesel",
  PETROL: "Essence",
  HYBRID: "Hybride",
  ELECTRIC: "Électrique",
  OTHER: "Autre",
} as const;

export const ROUTE_STATUS_LABELS = {
  PROPOSED: "Proposée",
  VALIDATED: "Validée",
} as const;

export const STOP_KIND_LABELS = {
  PICKUP: "Prise en charge",
  DROPOFF: "Dépose",
} as const;

export const USER_ROLE_LABELS = {
  REGULATOR: "Régulateur",
  DRIVER: "Chauffeur",
} as const;

export const VIOLATION_LABELS: Record<string, string> = {
  UNKNOWN_REFERENCE: "Référence inconnue",
  DUPLICATE_TRIP: "Course en double",
  PAIRING: "Prise en charge / dépose incohérentes",
  LOCK: "Course figée déplacée",
  VEHICLE_TYPE: "Type de véhicule non autorisé",
  CAPACITY: "Capacité dépassée",
  EXCLUSIVE_RIDE: "Patient non partageable accompagné",
  TIME_WINDOW: "Hors fenêtre horaire",
  TOTAL_WAIT: "Attente cumulée > 45 min",
  DETOUR: "Détour trop long",
  SHIFT: "Hors horaires du chauffeur",
  BREAK: "Pause non respectée",
};

export function formatEuros(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

export function formatKm(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} km`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: digits }).format(value);
}
