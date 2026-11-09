/**
 * French message of an HTTP error answered by the optimizer (services/optimizer,
 * app/security.py and pydantic). Pure: lib/optimizer/client.ts and the history
 * script share it.
 */
export function optimizerHttpErrorMessage(status: number, detail: string): string {
  switch (status) {
    case 401:
      return (
        "Le service d'optimisation a refusé l'accès : son jeton OPTIMIZER_TOKEN est absent ou différent de celui " +
        "de l'application. Mettez la même valeur des deux côtés, puis redémarrez."
      );
    case 413:
      return "Requête trop volumineuse pour le service d'optimisation : réduisez le nombre de courses ou de véhicules envoyés.";
    case 429:
      return (
        "Le service d'optimisation calcule déjà d'autres tournées (nombre de calculs simultanés atteint). " +
        "Réessayez dans une minute."
      );
    default:
      return `Le service d'optimisation a renvoyé une erreur (HTTP ${status}) : ${detail}`;
  }
}
