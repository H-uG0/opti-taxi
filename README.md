# Opti-Taxi

Optimiseur de tournées J+1 pour **Taxi & Ambulance V** (taxi conventionné, VSL, ambulance) sur l'axe
Marseille – Aix – Manosque – Sisteron – Gap – Grenoble.

L'outil propose chaque soir les tournées du lendemain : il affecte chaque course à un véhicule,
regroupe deux patients compatibles (transport partagé, décret 2025-202) et ordonne les arrêts pour
maximiser la marge estimée, sans violer aucune règle (détour, attente au lieu de soins, horaires des
chauffeurs, type de véhicule prescrit). Le régulateur ajuste, fige, réoptimise et valide ; les
chauffeurs suivent leur feuille de route sur téléphone.

Besoin et solution détaillés : [docs/besoin-et-solution.md](docs/besoin-et-solution.md).
Conventions de développement : [CLAUDE.md](CLAUDE.md).

## Architecture

```
apps/web               Next.js 16 (App Router) + TypeScript + Tailwind 4 + MapLibre GL
  prisma/              schéma PostgreSQL (Prisma 6), migrations, seed fictif
  src/app/(regulator)  écrans du régulateur : planning, courses, référentiels, tableau de bord
  src/app/chauffeur    feuille de route mobile (PWA)
  src/lib/optimizer    contrat zod, construction de la requête, client HTTP, enregistrement des tournées
services/optimizer     FastAPI + Google OR-Tools (PDPTW) + validateur indépendant des contraintes dures
contract/              contrat JSON web <-> optimizer (README + fixtures testées des deux côtés)
infra/osrm             préparation du graphe routier OSRM (PACA + Rhône-Alpes)
```

| Service | Port local |
| --- | --- |
| Web Next.js | 3100 |
| Optimizer FastAPI | 8100 |
| PostgreSQL | 5433 |
| OSRM (optionnel) | 5050 |

Le web appelle l'optimizer en HTTP (`POST /optimize`, `POST /evaluate`). Les temps et distances
viennent d'OSRM s'il est configuré (`OSRM_URL`), sinon d'une estimation à vol d'oiseau
(× 1,3, vitesses moyennes) signalée dans l'interface.

## Démarrage

Prérequis : Node 22+, pnpm 10, Python 3.12+, PostgreSQL 17 (Docker ou installation locale).

```bash
# 1. Base de données — au choix
docker compose up -d postgres                 # avec Docker
scripts/local-postgres.sh init                # sans Docker (binaires PostgreSQL locaux, port 5433)

# 2. Application web
cp .env.example apps/web/.env                 # puis changer SESSION_SECRET
pnpm install
pnpm db:migrate                               # applique les migrations
pnpm db:seed                                  # jeu de données 100 % fictif

# 3. Service d'optimisation — au choix
docker compose up -d --build optimizer
# ou
cd services/optimizer && python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"
.venv/Scripts/python -m uvicorn app.main:app --port 8100

# 4. Lancer le web
pnpm dev                                      # http://localhost:3100
```

### Comptes de développement (créés par le seed, données fictives)

| Rôle | Identifiant | Mot de passe |
| --- | --- | --- |
| Régulateur | `regulateur@opti-taxi.test` | `regulateur` |
| Chauffeur | `prenom.nom@opti-taxi.test` (liste affichée à la fin du seed) | `chauffeur` |

Ces comptes n'existent que dans la base de développement.

## Tests

```bash
pnpm test               # web : vitest (contrat, règles métier, KPI, construction des requêtes…)
pnpm typecheck
pnpm lint
pnpm optimizer:test     # optimizer : pytest (solveur, validateur, API, contrat)
```

## Données de santé

- Jamais de vraies données patients en développement : le seed génère des identités et adresses inventées.
- Production : hébergeur certifié HDS obligatoire, conformité RGPD.
- Le géocodage n'envoie que l'adresse saisie (jamais le nom du patient) à la Base Adresse Nationale (IGN Géoplateforme) ; il se désactive en vidant `GEOCODER_URL`.
- La PWA chauffeur ne met aucune page en cache hors ligne (téléphone perdu = pas de données patients).

## Hors périmètre du MVP

Facturation CPAM et télétransmission, prise d'appels, transports d'urgence. Version 2 envisagée :
réoptimisation en journée, suivi GPS, SMS aux patients, alertes de fin de prescription, durées apprises
sur l'historique, export vers le logiciel de facturation.
