# Synthèse pour Hugo : décisions à valider

Tirée du journal des améliorations, lots 1 à 17 (9 et 10 novembre). Rien n'est fusionné dans `main`.

## 1. À valider par Hugo avant de fusionner

- **Branches de base.** `fix/securite-exploitation` (lot 1) ne part pas de `main`. La fusionner emporte les 7 branches de l'appel PO (section 4). Elle emporte aussi leurs migrations `depots`, `staff_planning` et `vehicle_planning`. Vu dans git, absent du journal.
- **CLAUDE.md, ambulance exceptionnelle (lot 10).** Elle assouplit la règle « assis → VSL ou taxi ». Texte proposé : « …ou exceptionnellement une ambulance proposée par le régulateur pour une course non affectée (facturée au tarif VSL, motif tracé) ». À valider avant de fusionner `feat/tarifs-conventions-2025`.
- **CLAUDE.md, contraintes dures absentes.** Le code en ajoute trois :
  - temps à bord ≤ trajet direct + 30 min (`RIDE_TIME`) ;
  - conducteur non déclaré bloqué pour une course CPAM en taxi conventionné ;
  - au moins un DE en ambulance.

  Faut-il les ajouter aux règles métier ? Le journal ne le propose pas.
- **CLAUDE.md, glossaire (lot 9).** Le journal le dit en attente. Pourtant, le lot 15 l'a déjà appliqué aux écrans de la régulation. Le refuser oblige à reprendre `chore/ui-coherence-accessibilite`. Le valider oblige à changer le point 4 du MVP et deux passages de `docs/besoin-et-solution.md`. À trancher :
  - l'ordre du nom sur la feuille de route (aujourd'hui « Marie DUPONT ») ;
  - l'accord des boutons de l'application chauffeur ;
  - « 7 h 30 » ou « 07:30 » dans le document de besoin ;
  - trois écarts du lot 15 au glossaire :
    - « Personnel » au lieu de « Chauffeur » ;
    - un onglet « Accueils » sous le titre « Transports partagés » ;
    - « Déconnexion » au lieu de « Se déconnecter » dans l'application chauffeur.
- **Dépendances de test (lot 8) :** `@testing-library/react` 16, `@testing-library/dom` 10 et `jsdom` 26. `happy-dom` serait plus léger que `jsdom`.
- **Déploiement.** Des migrations aux lots 1, 2, 3, 4, 5, 7, 10 et 14, plus les 3 des branches de base. Le contrat change aux lots 1, 5, 6, 10 et 16. Le journal ne signale aucune perte de données. À faire :
  - déployer le web et l'optimiseur ensemble, puis lancer `prisma migrate deploy` ;
  - en production, poser `OPTIMIZER_TOKEN` avec la même valeur sur le web et l'optimiseur. Sans jeton, l'optimiseur accepte tout appel ;
  - ensuite, ressaisir les grilles ou relancer le seed. Sinon le CA est sous-estimé, car les grilles migrées sont sans majoration. La démo en ligne a été rechargée le 10/11 après le lot 10 : ses grilles sont les bonnes.
  - l'hébergeur doit permettre l'extension `unaccent` (lot 14).
- **Pistes produit (lot 9).** Les dix pistes « Ce qu'Opti-Taxi en retient » restent à valider, dont un prix par véhicule et par mois.

## 2. À trancher avec le PO

**Règles et équipages**
- **Ambulance (lot 4) :** au moins un DE, quel que soit le conducteur. Faut-il imposer le DE auprès du patient ? L'équipage bariatrique à trois n'est pas géré.
- **Remplaçants (lot 4) :** 60 km au plus entre dépôts, donc Marseille–Manosque (66 km) est exclu. 4 h d'horaire commun en ambulance. Pas de réserve par dépôt.
- **Pause (lot 5) :** 20 min dans toute tournée de plus de 6 h, placée n'importe où. Plus de 6 h d'affilée avant la pause reste permis. À trancher selon l'accord de V (TT-01).
- **Contrôle technique ou assurance dépassés (lot 2) :** le véhicule est signalé mais reste planifiable. Faut-il le bloquer ?
- **Conducteur non déclaré (TAR-02) :** le blocage pour la CPAM est à confirmer. La règle des 50 % du territoire de l'ADS est une pénalité, pas une contrainte dure.

**Objectif et réoptimisation**
- **Pénalité (lot 6) :** 10 000 € par course non servie ou par patient à moitié servi. Le 10/11 de la démo, un patient reste au centre sans retour, à 126 km de chez lui. Trois options : garder ces poids, servir d'abord le retour, ou baisser la pénalité.
- **Temps à bord (lot 5) :** la limite de 30 min fait tomber le partage à 38 %, au lieu de 43 à 46 %. Elle se règle de 0 à 180 min. Les catégories de soins du décret ne sont pas saisies.
- **« Où placer » (lot 16) :** les places sont classées par marge. Une place à +183 km peut donc passer en tête. Faut-il classer par km, ou favoriser le partage ?
- **Réoptimisation (lots 6, 16, 17) :** aucun bonus de stabilité. Le calcul attend l'accord du régulateur dans trois cas :
  - une course change de véhicule ;
  - une course perd ou gagne un véhicule ;
  - sa prise en charge bouge de 10 min ou plus (seuil fixe).

  Le jour même, une place est refusée si la prise en charge tombe à moins de 10 min de l'heure actuelle.
- **Écrans à voir avec la régulation de V (lots 11, 13, 15) :** la densité détaillée par défaut, les 12 teintes par véhicule et le violet du partage, proche du badge « simulé ».

**Tarifs**
- **Certification (lots 9, 10) :** l'entreprise de la démo est certifiée depuis le 01/01/2025, avec son siège à Marseille. L'abattement de partage du VSL est de 15 % et 33 % si l'entreprise est certifiée, sinon de 23 % et 35 %.
- **Lectures des conventions (lot 10) :**
  - retour à vide du taxi compté ;
  - majorations multipliées (T3 : 262,59 € au lieu de 238,08 €) ;
  - samedi majoré dès 12:00, aussi en VSL et en ambulance ;
  - trajet court majoré aussi en ambulance (question ouverte) ;
  - lien avec une hospitalisation : dialyse, radiothérapie et chimiothérapie, mais pas les « hôpitaux ». Ce choix décide si le retour à vide du taxi est facturé ;
  - CA TTC (TVA du VSL non retirée) ;
  - détour jamais facturé en taxi.
- **PMT renouvelée d'office (lot 3) :** deux séries de même mode dans le même établissement se confondent. Une course peut donc aller sur la mauvaise PMT. À revoir avec la catégorie de soins.
- **Ambulance exceptionnelle :** facturée à la grille VSL. Le code de facturation est à demander à V.
- **Preuves et coûts :**
  - le calcul est vérifié sur 36 factures construites, pas sur de vraies factures de V (TAR-01) ;
  - le jeu fictif paie 90 % (ambulanciers) et 94 % (taxis) de l'amplitude. Cela suppose le régime d'équivalence, à confirmer avec V.

**Données de santé (V ou son DPO)**
- **Session chauffeur (lot 7) :** elle se prolonge au plus 7 jours après la saisie du mot de passe (`DRIVER_MAX_SESSION_DAYS`).
- **Planning (lot 11) :** le téléphone, la mobilité, les consignes et les notes de toutes les courses du jour partent au navigateur. Faut-il les charger seulement à l'ouverture du panneau ? La copie chiffrée hors ligne est à voir avec l'hébergeur HDS.

Liste complète : `docs/besoin-et-solution.md`, section « Questions à poser au client ».

## 3. Choix techniques par défaut (rien à faire sauf objection)

Le détail est dans le journal, section « Décisions prises en l'absence d'Hugo ». L'essentiel :
- Un nouveau calcul demande confirmation dans trois cas : il sert moins de courses, il a plus de violations, ou il perd en marge plus de 10 % du CA.
- Les données de démo ne se chargent qu'avec `DEMO_MODE=1`.
- L'optimiseur est limité à 2 calculs simultanés, 8 Go de mémoire, 10 Mo par requête, 300 véhicules et 3 000 courses.
- Les courses sont créées de J+1 à J+14. Une annulation est tardive sous 2 h. Le motif d'annulation n'entre pas dans le journal d'audit.

## 4. Branches

Les fusionner dans cet ordre. Chaque branche contient la précédente.
1. Branches de base (appel PO) : `chore/test-charge-flotte` → `fix/solveur-grande-flotte` → `fix/web-plan-vide` → `perf/lieux-de-pause` → `feat/depots` → `feat/planning-personnel` → `feat/planning-vehicules`.
2. Lots 1 → 17 dans l'ordre, de `fix/securite-exploitation` à `feat/brouillon-glisser-deposer`.