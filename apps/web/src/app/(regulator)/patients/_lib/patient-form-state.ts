/**
 * The patient form's state: the app's FormState (lib/forms) plus, on creation,
 * existing records that may be the same person (« Créer quand même » confirms).
 */
import type { FormState } from "@/lib/forms";

/** An existing patient that may be the one being created (same name, phone or address). */
export type SimilarPatient = { id: string; name: string; city: string; active: boolean; reasons: string[] };

export type PatientFormState = FormState & { similar?: SimilarPatient[] };
