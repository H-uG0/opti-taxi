/** Sign-in messages, shared by the login action and the login page. */

export const WRONG_CREDENTIALS = "Adresse e-mail ou mot de passe incorrect.";

/** A driver account whose Driver record is missing or deactivated (see accountRefusal). */
export const NO_ACTIVE_DRIVER = "Ce compte chauffeur n'est relié à aucune fiche chauffeur active : contactez le régulateur.";

/**
 * Sign-in refused by the throttle (lib/auth/login-throttle.ts). Same text
 * whether the account exists or not.
 */
export function tooManyAttempts(retryInMin: number): string {
  return `Trop de tentatives de connexion. Réessayez dans ${retryInMin} min.`;
}
