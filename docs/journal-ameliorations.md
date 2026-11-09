# Journal des améliorations

Session d'amélioration continue lancée le 9 novembre 2026 à la demande d'Hugo : « améliorer et peaufiner chaque détail de l'app, anticiper les futures demandes, étudier la concurrence ». Hugo n'est joignable qu'une fois par jour : ce journal dit ce qui a été fait, ce qui attend une décision et où regarder.

Règles suivies : une branche par lot, empilées les unes sur les autres et jamais fusionnées dans `main` sans accord ; aucune donnée réelle ; chaque lot est relu sous trois angles (justesse, produit, sécurité) avant d'être poussé, puis déployé sur la démo (https://opti-taxi.2-24-57-241.sslip.io).

## Étude de départ (9 novembre)

- **Concurrence française** : ERP complets (SCR'AMBGES, Saphir avec l'outil d'optimisation EMMAI, Lomaco, Arobas, Drivesoft, Caree…) qui font régulation, facturation et télétransmission ; jeunes outils de régulation (SanteMobile, Becose). Leurs arguments : réaffectation instantanée en journée, glisser-déposer, application chauffeur avec statuts, géolocalisation. Opti-Taxi garde un avance sur l'optimisation J+1 (marge, règles du transport partagé revérifiées, équipages du jour).
- **Outils étrangers de transport à la demande** (RouteGenie, Tripmaster, Ecolane, Spare, Via…) : frise de type Gantt avec glisser-déposer, tableau des exceptions, retours « sur appel », SMS et lien de suivi pour les patients, indicateurs par chauffeur.
- **Réglementation** : obligation annoncée de géolocalisation certifiée et de facturation électronique intégrée (SEFi) dans tous les véhicules au 1er janvier 2027 (à recouper, voir le lot de veille) ; décret 2025-202 sur le transport partagé ; prescription électronique de transport.
- **Audit du code et des écrans** : environ 400 constats, regroupés en un plan de travail de 34 lots (fichier de travail hors dépôt), dont les premiers sont : sécurité d'exploitation, intégrité du planning, courses et récurrences, règles d'équipage, conformité de l'optimiseur, terrain chauffeur, données de démonstration à l'échelle de V, puis l'interface à 120 véhicules.

## Lots réalisés

### 1. Sécurité d'exploitation — branche `fix/securite-exploitation` (9 novembre)

- Les données de démonstration ne se chargent plus que si `DEMO_MODE=1` est posé explicitement ; un bandeau « DÉMO — données fictives » s'affiche alors partout. En production hors démo, le serveur refuse de démarrer s'il trouve des comptes de démonstration en base.
- Service d'optimisation protégé : ports limités à la machine, jeton partagé entre le web et l'optimiseur (`OPTIMIZER_TOKEN`, posé sur la démo), deux calculs simultanés au plus, taille des requêtes bornée.
- Journal d'audit inaltérable (la base refuse toute modification ou suppression), auteur figé dans chaque événement, échecs de connexion tracés ; toutes les écritures sensibles qui n'étaient pas tracées le sont (équipages, absences, véhicules, tarifs, paramètres…), avec un test qui échoue si une nouvelle action oublie l'audit.
- Mot de passe chauffeur provisoire : un compte créé ou réinitialisé par la régulation doit changer son mot de passe à la première connexion. Les comptes de démonstration n'y sont pas soumis.
- Plus de nom de patient dans les enregistrements techniques.
- Écrans de planification : un arrêt maladie, un congé ou une autre absence s'affichent tous « Absence », pour qu'on ne puisse pas les distinguer ; la garde et la formation restent nommées (utile à la régulation). Le motif complet n'apparaît que sur la fiche de la personne.
- Tests : 1 027 tests web (967 avant), 133 tests de l'optimiseur.

## Décisions prises en l'absence d'Hugo (à valider)

- Lot 1 : les comptes de démonstration ne sont pas soumis au mot de passe provisoire ; le jeton de l'optimiseur est facultatif (avertissement au démarrage s'il manque) ; limites par défaut : 2 calculs simultanés, 8 Go de mémoire, 10 Mo par requête, 300 véhicules et 3 000 courses par calcul.

## Questions pour le PO

(liste consolidée tenue dans `docs/besoin-et-solution.md`, section « Questions à poser au client »)
