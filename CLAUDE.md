# Projet : optimiseur de tournées — Taxi & Ambulance V

Document de besoin complet : [docs/besoin-et-solution.md](docs/besoin-et-solution.md).

## Contexte
Société de taxi conventionné, VSL et ambulance sur l'axe Marseille – Grenoble
(Aix, Manosque, Sisteron, Gap). Patients surtout réguliers (dialyse, chimio, radiothérapie).
Objectif : plus de courses facturées par véhicule et par jour, moins de km à vide,
plus de transports partagés, sans retard aux rendez-vous.

## Ce qu'on construit (MVP)
Outil web de planification de J+1 :
1. Gestion patients, établissements, prescriptions, récurrences, véhicules, chauffeurs, grilles tarifaires.
2. Génération des courses de la semaine à partir des récurrences.
3. Bouton « Optimiser demain » : tournées par véhicule via le service d'optimisation.
4. Planning par véhicule (frise + carte), ajustement manuel, verrouillage, réoptimisation du reste.
5. Feuille de route chauffeur sur mobile (PWA).
6. Tableau de bord : courses/véhicule/jour, % km à vide, % partagé, retards, temps de planification.
Hors périmètre : facturation CPAM, télétransmission, transports d'urgence.

## Règles métier (contraintes dures de l'optimiseur)
- Le mode prescrit fixe le véhicule : allongé -> ambulance ; assis -> VSL ou taxi.
- Ambulance : 1 patient. Taxi et VSL : 2 patients max (paramètre par véhicule).
- Partage seulement si la prescription l'autorise (aller, retour ou les deux).
- Détour <= 10 km par patient ajouté, 30 km au maximum.
- Attente au lieu de soins <= 45 min au total (avant le RDV + après la séance).
- Refus de partage tracé sur la course.
- Horaires et pauses des chauffeurs respectés.
- Tarifs stockés en base (type, département, dates de validité), jamais en dur dans le code.

## Objectif d'optimisation
Maximiser : CA estimé - (km x coût/km + heures x coût/h) - pénalité x courses non affectées.
Toute solution renvoyée doit passer un validateur indépendant qui revérifie chaque contrainte dure.

## Stack
- Monorepo pnpm, docker-compose pour le développement local.
- apps/web : Next.js 16 (App Router) + TypeScript, Tailwind v4, MapLibre GL.
- Base : PostgreSQL + Prisma 6 (`prisma-client-js`, client généré dans node_modules).
- services/optimizer : Python 3.12+, FastAPI, Google OR-Tools (pickup and delivery with time windows).
- Contrat JSON entre web et optimizer : zod côté TypeScript, pydantic côté Python.
- OSRM en Docker (extraits OpenStreetMap PACA + Auvergne-Rhône-Alpes) pour les temps et distances ;
  repli automatique sur une estimation à vol d'oiseau quand OSRM n'est pas configuré.

## Données
- Jamais de vraies données patients en développement : jeu fictif généré par le seed.
- Production : hébergeur certifié HDS (données de santé).

## Glossaire
- TAP : transport assis professionnalisé (taxi conventionné ou VSL).
- VSL : véhicule sanitaire léger. Dans le vocabulaire de V, « ambulance » = VSL et « ambulance couché » = ambulance.
- PMT : prescription médicale de transport.
- Transport partagé : au moins 2 patients en même temps dans un véhicule TAP.
- Série : transports répétés pour un même traitement.

## Conventions techniques (décidées au démarrage)

### Ports locaux (3000, 5432, 8000, 8080 sont déjà pris sur le poste de dev)
| Service | Port |
| --- | --- |
| Web Next.js | 3100 |
| Optimizer FastAPI | 8100 |
| PostgreSQL (docker) | 5433 |
| OSRM (profil docker `osrm`) | 5050 |

### Unités, partout (base, contrat, UI)
- **Heures de la journée planifiée : entiers en minutes depuis minuit, heure locale Europe/Paris**
  (`450` = 07:30). Champs suffixés `Minute` en base, `Min` dans le contrat.
- Instants réels (statut chauffeur, validation, horodatage) : `DateTime` UTC.
- Dates de service : `@db.Date` en base, chaîne `YYYY-MM-DD` dans le contrat et les URL.
- Distances en km (float), montants en euros (float), taux en fraction (0.23 = 23 %).
- Jours de semaine : ISO, 1 = lundi … 7 = dimanche.

### Langue
- Interface et documentation en français ; identifiants et commentaires de code en anglais.
- Correspondance des termes : course = `Trip`, tournée = `Route`, arrêt = `RouteStop`,
  établissement = `Facility`, récurrence = `Recurrence`, grille tarifaire = `TariffGrid`,
  aller = `OUTBOUND`, retour = `RETURN`, régulateur = `REGULATOR`.

### Contrat web ↔ optimizer
- Source de vérité : `contract/README.md` + exemples `contract/fixtures/*.json`.
- `apps/web/src/lib/optimizer/contract.ts` (zod) et `services/optimizer/app/schemas.py` (pydantic)
  doivent tous deux accepter les fixtures : un test de chaque côté le vérifie.
- Toute évolution du contrat modifie les trois en même temps.

### Web
- Accès aux données : composants serveur + server actions ; Prisma uniquement côté serveur (`@/lib/db`).
- Chaque server action et chaque page protégée appelle `requireUser(role)` (`@/lib/auth`).
- Rôles : `REGULATOR` (écrans de planification, /…) et `DRIVER` (feuille de route, /chauffeur).
- Composants UI partagés dans `src/components/ui` ; ne pas ajouter de bibliothèque de composants.
- Pas de nouvelle dépendance sans le signaler.

## Commandes
```bash
docker compose up -d postgres optimizer   # base + service d'optimisation
pnpm install
pnpm db:migrate && pnpm db:seed           # schéma + données fictives
pnpm dev                                  # http://localhost:3100
pnpm test                                 # tests web (vitest)
pnpm optimizer:test                       # tests optimizer (pytest)
```

## Façon de travailler
Avancer par petites étapes testées ; demander avant tout choix structurant.
