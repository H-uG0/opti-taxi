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

### 2. Intégrité du planning — branche `fix/planning-integrite` (9 novembre)

- **Plus de remplacement silencieux du planning.** Avant d'enregistrer un nouveau calcul (« Réoptimiser », « Déplacer vers… »), l'outil le compare au planning en place : courses servies, violations de contraintes, marge, kilomètres. S'il sert moins de courses, a plus de violations ou fait perdre beaucoup de marge, il n'est pas enregistré : le planning affiche « Ce calcul sert 280 courses contre 300 dans le planning actuel, avec 2 violations… : remplacer quand même ? » avec les chiffres côte à côte, et le régulateur choisit en un clic « Remplacer quand même » ou « Garder le planning actuel ». Les seuils se règlent dans Paramètres (« Remplacement du planning en place »).
- Un déplacement qui laisserait d'autres courses sans véhicule est refusé, le planning reste tel quel.
- **« Revenir au planning précédent »** : chaque calcul garde les tournées qu'il a remplacées ; tant que la journée n'a pas commencé, un clic les rétablit, horaires recalculés avec les données du jour (les courses annulées et les véhicules devenus indisponibles depuis sont laissés de côté, et le même comparatif s'applique).
- Après l'annulation d'une course, les violations recalculées sont enregistrées : le planning et la validation lisent les vraies violations du moment, plus celles du dernier calcul.
- **Pages périmées** : si un collègue (ou un autre onglet) a modifié le planning depuis l'affichage, « Valider » et « Figer » sont refusés avec « Le planning a changé depuis l'affichage : rechargez la page » et un bouton « Recharger ». Pendant un calcul, la page se tient à jour toute seule (toutes les 5 s, et au retour sur l'onglet) et propose « Planning modifié — Recharger ».
- Deux clics simultanés ne lancent plus deux calculs de la même date (verrou en base). « Optimiser » et « Valider » sont grisés, avec la raison, pendant un calcul ; « Optimiser » et « Déplacer » le sont aussi quand l'optimiseur est hors ligne.
- **Tournées devenues impossibles** : le panneau « À traiter » a une section « Véhicules à revoir » pour un véhicule devenu indisponible après le calcul, un chauffeur ou un équipier absent ou remplacé dans l'équipage du jour (avec le nom du remplaçant), ou un contrôle technique ou une assurance dépassés à la date planifiée. La même liste s'affiche sur Équipages, et la validation demande confirmation en citant ces cas, les retours à vérifier et les courses à revoir.
- **Tarifs** : la page Grilles tarifaires vérifie demain et les 7 jours suivants (« La grille VSL 04 expire le 30/11 : aucune ne prend le relais ») ; le planning affiche un bandeau, et le message d'optimisation une note, quand un véhicule du jour n'a pas de grille.
- Petits défauts corrigés : le message « Optimisation en cours » ne passe plus d'une date à l'autre ; « Figer » et « Défiger » sont grisés sur une date passée ; une erreur de base de données donne un vrai message au lieu de « connexion perdue ? » ; la carte ne se recadre plus après chaque action ; la page d'erreur du planning parle au régulateur ; les flèches de date montrent le chargement.
- Migration `replan_guard` (statut « en attente de confirmation » et deux paramètres, valeurs par défaut, aucune donnée modifiée).
- Tests : 1 095 tests web (1 027 avant) ; optimiseur inchangé.
- **Après revue** : « Remplacer quand même » fonctionne désormais après un « Déplacer vers… » (il échouait toujours) ; « Revenir au planning précédent » après un déplacement remet aussi le verrou d'avant, sans violation. Le planning en place est jugé sur ce qui peut encore rouler : une tournée devenue impossible (véhicule indisponible, équipage changé) ne compte plus comme « servie », la question le dit, et elle ne bloque plus les déplacements. Les courses perdues et les violations d'un calcul en attente sont nommées (patient, aller ou retour, heure), et ce bandeau prend le focus. La validation redemande confirmation si la liste des points à traiter a changé entre-temps, et ne compte plus l'échéance dépassée d'un véhicule sans tournée. Messages : chaque course d'un refus est nommée, un déplacement refusé n'est plus affiché en « Échec de l'optimisation », toute erreur qui demande de recharger propose « Recharger ». Tests : 1 105 tests web.

## Décisions prises en l'absence d'Hugo (à valider)

- Lot 1 : les comptes de démonstration ne sont pas soumis au mot de passe provisoire ; le jeton de l'optimiseur est facultatif (avertissement au démarrage s'il manque) ; limites par défaut : 2 calculs simultanés, 8 Go de mémoire, 10 Mo par requête, 300 véhicules et 3 000 courses par calcul.
- Lot 2 : un nouveau calcul demande confirmation s'il sert ne serait-ce qu'une course de moins (seuil réglable, 0 par défaut), s'il a plus de violations que le planning en place (aucune tolérance, y compris pour un premier calcul), ou si sa marge baisse de plus de 10 % du CA du planning en place (réglable) ; les kilomètres sont montrés mais ne déclenchent rien seuls (ils sont déjà dans la marge).
- Lot 2 : un calcul en attente de confirmation n'est enregistrable que si rien n'a changé depuis (courses, verrous, équipages, véhicules, tarifs, paramètres, tournées) ; sinon il est écarté et il faut relancer. Un nouveau calcul ou une validation l'écarte aussi.
- Lot 2 : « Valider » reste possible quand l'optimiseur est hors ligne (la validation n'en a pas besoin) ; seuls « Optimiser », « Déplacer » et « Revenir au planning précédent » sont grisés.
- Lot 2 : un contrôle technique ou une assurance dépassés à la date planifiée sont signalés (« À traiter », Équipages, confirmation de la validation) mais ne retirent pas le véhicule du planning : bloquer automatiquement ce véhicule reste une question pour le PO. Une échéance qui tombe le jour même est considérée comme encore valable ce jour-là.
- Lot 2 : la vérification des tarifs porte sur les véhicules actifs, de demain à J+8 ; le jeu de démonstration n'a pas été modifié pour provoquer une alerte (elle fausserait le CA de la démo).
- Lot 2 (revue) : un déplacement reste refusé dès qu'il fait sortir une autre course du planning, même si l'optimiseur en place une autre à la place (critère du lot). Sur les données de démonstration, cela arrive souvent ; demander plutôt confirmation en nommant les courses perdues et gagnées est une question pour le PO.

## Questions pour le PO

(liste consolidée tenue dans `docs/besoin-et-solution.md`, section « Questions à poser au client »)
