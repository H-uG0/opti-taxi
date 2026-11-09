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

## Essayer en une commande (Docker)

Prérequis : [Docker Desktop](https://www.docker.com/products/docker-desktop/) démarré, et les ports
3100, 5433 et 8100 libres.

```bash
git clone https://github.com/H-uG0/opti-taxi.git
cd opti-taxi
docker compose up --build
```

Le premier lancement construit les images (10 à 20 minutes selon la machine), crée la base et charge
le jeu de données fictif. Ouvrir ensuite http://localhost:3100 (Chrome ou Edge) et se connecter avec
un des comptes ci-dessous. Ce lancement est une démonstration : `docker-compose.yml` pose
`DEMO_MODE=1`, qui charge le jeu fictif sur une base vide et affiche le bandeau « DÉMO — données
fictives » sur toutes les pages. L'historique des 20 derniers jours ouvrés, utilisé par le tableau de bord,
se calcule en arrière-plan pendant quelques minutes après le démarrage. Arrêt : `Ctrl+C`, puis
`docker compose down` (ajouter `-v` pour repartir d'une base vide au prochain lancement).

### Itinéraires routiers précis (OSRM, facultatif)

Sans OSRM, temps et distances sont estimés à vol d'oiseau. Pour des temps et kilomètres routiers
réels, calculés sur le poste (aucune adresse ne part chez un tiers) :

```bash
bash infra/osrm/prepare.sh                    # une fois : ~1 Go à télécharger, environ 1 h
docker compose --profile osrm up -d osrm      # serveur d'itinéraires, port 5050
echo "OSRM_URL=http://osrm:5000" > .env       # lu par docker compose (fichier ignoré par git)
docker compose up -d optimizer                # http://localhost:8100/health -> "matrixSource":"osrm"
```

Le script fusionne les cartes OpenStreetMap de PACA et de Rhône-Alpes, puis garde le corridor
desservi (Marseille – Valence – Grenoble – Briançon, `OSRM_BBOX` pour le changer) : le traitement
tient alors dans 2 Go de mémoire et le serveur en occupe environ 500 Mo. Sous Windows, le lancer
depuis Git Bash. Hors Docker, l'optimiseur prend `OSRM_URL=http://localhost:5050`. Si OSRM ne répond
pas, l'optimiseur revient à l'estimation à vol d'oiseau et l'affiche ; supprimer `.env` pour s'en
passer. OSRM calcule à circulation fluide : le trafic s'y ajoute par les facteurs ci-dessous.

### Trafic

Les temps de trajet sont ralentis selon l'heure et l'endroit (Paramètres, section Trafic) : un facteur
par zone (Marseille, Aix, Grenoble, reste du réseau) et par créneau (pointe du matin, journée, pointe
du soir). Seule la part du trajet passée dans la zone est ralentie, et aucune adresse ne quitte le
serveur. Le temps d'un trajet dépend de l'heure attendue de ses deux extrémités (rendez-vous, fin de
séance), connue avant le calcul : il prend le créneau le plus lent des deux, car un Gap → Marseille
parti avant la pointe arrive en plein dedans. Solveur, planification et validateur utilisent donc le
même temps. Le week-end, le facteur « Journée » vaut toute la journée.

Les valeurs fournies sont un point de départ, pas des mesures. Elles se calibrent avec les données de
V : les heures réelles de prise en charge et de dépose donnent, à partir de 20 trajets mesurés par
case, une valeur observée que le régulateur applique d'un clic. Elle n'est jamais appliquée seule.
Une API de trafic (temps réels par créneau) se brancherait comme un autre fournisseur
(`services/optimizer/app/traffic.py`), sans toucher au solveur ni au validateur, mais enverrait les
coordonnées des domiciles à un tiers : à valider d'abord (RGPD, HDS).

## Démarrage (développement)

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

# 4. Historique fictif (facultatif, l'optimiseur doit tourner)
pnpm db:history                               # 20 jours ouvrés passés, pour le tableau de bord

# 5. Lancer le web
pnpm dev                                      # http://localhost:3100
```

`pnpm db:history [--days N] [--budget S]` simule les N jours ouvrés précédant aujourd'hui (20 par
défaut) avec les modules de l'application : génération des courses, optimisation, réponses de partage,
annulations, absences, horaires réels des chauffeurs, validation, journal d'audit. Il ne touche jamais
aujourd'hui ni les jours suivants, laisse tels quels les jours qui contiennent des données qu'il n'a pas
créées (les jours du seed, un jour planifié dans l'application) et remonte d'autant, et peut être
relancé (il remplace sa simulation précédente). Comme le seed, il refuse une base qui n'est pas locale
ou qui contient des comptes étrangers au jeu fictif (`@opti-taxi.test`). Compter environ 5 minutes.

### Comptes de développement (créés par le seed, données fictives)

| Rôle | Identifiant | Mot de passe |
| --- | --- | --- |
| Régulateur | `regulateur@opti-taxi.test` | `regulateur` |
| Chauffeur | `prenom.nom@opti-taxi.test` (liste affichée à la fin du seed) | `chauffeur` |

Ces comptes n'existent que dans la base de développement et dans la démo (`DEMO_MODE=1`) ; leurs mots de
passe ne sont pas provisoires (un compte créé dans l'application l'est, voir « Données de santé et
sécurité »). Ces mots de passe étant publics, l'image Docker ne charge jamais le jeu fictif sans
`DEMO_MODE=1`, et le serveur refuse de démarrer en production hors démo si un compte `@opti-taxi.test`
existe.

## Tests

```bash
pnpm test               # web : vitest (contrat, règles métier, KPI, construction des requêtes…)
pnpm typecheck
pnpm lint
pnpm optimizer:test     # optimizer : pytest (solveur, validateur, API, contrat)
```

## Données de santé et sécurité

- Jamais de vraies données patients en développement : le seed génère des identités et adresses inventées.
- Production : hébergeur certifié HDS obligatoire, conformité RGPD.
- Le géocodage n'envoie que l'adresse saisie (jamais le nom du patient) à la Base Adresse Nationale (IGN Géoplateforme) ; il se désactive en vidant `GEOCODER_URL`.
- La PWA chauffeur ne met aucune page en cache hors ligne (téléphone perdu = pas de données patients).
  Son service worker (`apps/web/public/sw.js`, écrit à la main) ne garde que l'icône, le numéro de la
  régulation et l'heure de la dernière synchronisation, pour une page « Pas de réseau » quand
  l'application est rouverte sans connexion. Les statuts tapés hors réseau attendent dans une file sur le
  téléphone (IndexedDB : identifiant de l'arrêt, action, heure du geste, rien d'autre) et partent au
  retour du réseau ; le serveur les enregistre à l'heure du geste (bornée : pas dans le futur, au plus
  3 h avant, jamais avant un statut déjà saisi plus tôt dans la tournée) et garde aussi l'heure de
  réception. Chaque envoi dit à quel compte appartient la file : sous la session d'un autre compte, le
  statut attend la reconnexion de son titulaire.
- **Sessions** : jeton signé de 12 h, revérifié en base à chaque requête. Celle d'un chauffeur est
  prolongée de 12 h dès qu'il en reste moins de 5 et que l'application joint le serveur (statut,
  ouverture, retour sur l'écran), pendant 7 jours au plus après la saisie du mot de passe
  (`DRIVER_MAX_SESSION_DAYS`, à valider avec le DPO) ; la feuille de route affiche « Session valable
  jusqu'à HH:MM » et prévient 30 min avant la fin. La déconnexion ferme les
  sessions du compte sur tous ses appareils. Désactiver un chauffeur ou son accès, ou lui donner un
  nouveau mot de passe ou une nouvelle adresse e-mail, coupe sa session ouverte dès sa prochaine action
  ou actualisation ; une réactivation ne la fait pas revenir (le chauffeur se reconnecte).
- **Mot de passe chauffeur provisoire** : le mot de passe que le régulateur saisit à la création du
  compte ou à sa réinitialisation est provisoire. À la connexion suivante, le chauffeur doit en choisir
  un à lui (`/chauffeur/mot-de-passe`) avant d'ouvrir sa feuille de route ; ses autres sessions sont
  alors fermées. Une fois ce choix fait, la régulation ne connaît plus le mot de passe du chauffeur.
  Limite : celui qui connaît le mot de passe provisoire (la régulation, ou quiconque l'a vu passer)
  peut se connecter avant le chauffeur et choisir le mot de passe à sa place. Ce n'est pas impossible,
  mais cela se voit : le mot de passe provisoire ne fonctionne plus pour le chauffeur, qui appelle la
  régulation, et le changement figure au journal d'audit (`account.password_change`, avec l'adresse IP
  et l'empreinte du navigateur). Chaque mot de passe actuel erroné saisi sur cette page est tracé
  (`account.password_change_failed`) et compte dans le blocage des connexions (5 échecs : 15 minutes,
  pour cette page comme pour la connexion). La page « Changer mon mot de passe » reste accessible
  depuis le bas de la feuille de route. Les comptes du jeu fictif ne sont pas provisoires (la démo
  s'ouvre avec les mots de passe publiés).
- **Connexion** : après 5 échecs en 15 minutes sur une même adresse e-mail, la connexion à ce compte
  est refusée pendant 15 minutes ; après 30 tentatives en 5 minutes depuis une même adresse IP, elle est
  refusée depuis cette adresse pendant 5 minutes. Le message est le même que le compte existe ou non.
  L'adresse IP n'est prise en compte que derrière un proxy déclaré par `TRUSTED_PROXY_HOPS` (1 derrière
  nginx) ; sinon toutes les connexions partagent un seul compteur (120 tentatives en 5 minutes), ce que
  le serveur signale au démarrage en production. Revers assumé : quiconque connaît l'adresse e-mail
  d'un compte peut en bloquer la connexion 15 minutes, de façon renouvelable ; le blocage, en mémoire,
  se lève aussi en redémarrant le serveur web.
- **Journal d'audit** (table `AuditEvent`) : les connexions, déconnexions, échecs de connexion et
  blocages pour trop de tentatives (le compte visé par son identifiant ; l'e-mail n'y figure jamais, et
  une adresse qui ne correspond à aucun compte n'y figure que sous forme d'empreinte `emailTag`, un
  hachage sans clé qu'on peut retrouver en essayant des adresses : elle n'est donc jamais stockée pour
  un compte existant), les mots de passe actuels erronés saisis par un chauffeur ; les
  consultations (liste des patients, fiche patient et ses formulaires, saisie d'une course, fiche
  établissement, liste des courses, planning d'un jour, feuille de route, arrivées partagées, fiche
  chauffeur, équipages du jour) ; qui a créé, modifié, annulé ou déplacé un patient, une prescription,
  une récurrence, un établissement, une course, une tournée, un chauffeur ou un compte, qui a saisi
  ou annulé une prise en charge, une dépose ou une absence, et toute modification des équipages, des
  absences et incompatibilités du personnel, des véhicules (indisponibilités, échéances, pleins), des
  dépôts, des grilles tarifaires et des paramètres (ancienne et nouvelle valeur, dont le numéro de la
  régulation). Chaque événement garde le nom de son auteur au moment de l'action, l'adresse IP (derrière
  un proxy déclaré par `TRUSTED_PROXY_HOPS`) et une empreinte du navigateur. Il ne contient jamais de
  nom de patient, d'adresse ni de note. L'auteur d'une prise en charge, d'une absence ou d'une réponse
  de partage est aussi affiché sur la course (Courses et Planning).
  La base refuse toute modification ou suppression du journal (déclencheur) ; un compte qui a des
  événements ne peut plus être supprimé, seulement désactivé. Seuls le seed et la simulation
  d'historique de développement lèvent ce verrou, le temps de leur transaction. En production, la
  base doit avoir deux rôles distincts (kit de déploiement, lot PROD-01) : un rôle de migration,
  propriétaire des tables, et un rôle d'exécution pour l'application, sans droit de propriétaire,
  privé de `UPDATE`, `DELETE` et `TRUNCATE` sur `AuditEvent`
  (`REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEvent" FROM <rôle d'exécution>;`) : il ne peut alors ni
  modifier le journal ni désactiver le déclencheur. Le conteneur web applique les migrations avec
  `MIGRATION_DATABASE_URL` (rôle de migration) et sert l'application avec `DATABASE_URL` (rôle
  d'exécution) ; sans `MIGRATION_DATABASE_URL` (développement, démo), `DATABASE_URL` sert aux deux.
  Ne jamais rendre le rôle d'exécution propriétaire pour faire passer les migrations : il pourrait
  alors désactiver le déclencheur et se redonner les droits retirés. Le rôle d'exécution reçoit les
  droits de lecture et d'écriture sur les tables et séquences, y compris celles des migrations
  futures (`ALTER DEFAULT PRIVILEGES FOR ROLE <rôle de migration> …`), puis le `REVOKE` ci-dessus.
- **Service d'optimisation** : il reçoit les coordonnées des domiciles et les rendez-vous. Avec
  `OPTIMIZER_TOKEN` (même valeur sur le web et sur l'optimiseur), il refuse tout appel sans ce jeton
  (`401`), avant même de lire la requête, sur toutes ses adresses sauf `/health` (sa documentation
  `/docs` comprise) ; sans jeton il accepte tout appel, ce que les deux services signalent au démarrage en
  production. Il limite les calculs simultanés (2 par défaut, `429` au-delà : « réessayez dans une
  minute »), la taille des requêtes (10 Mo) et leur contenu (300 véhicules, 3 000 courses), et son
  conteneur est limité à 8 Go de mémoire. En production il reste sur un réseau privé, sans port
  publié. Les ports de `docker-compose.yml` n'écoutent que sur la machine elle-même (127.0.0.1).
- **Journaux serveur** : les erreurs, y compris celles que Next.js journalise lui-même, sont écrites
  sans les arguments des requêtes Prisma (qui contiendraient adresses et notes). Les enregistrements
  techniques ne contiennent pas de nom de patient : un « Déplacer vers… » refusé garde l'identifiant
  de la course dans l'erreur de l'optimisation, et le nom n'est ajouté qu'à l'affichage.
- **Journaux du proxy** (à prévoir dans le kit de déploiement HDS, lot PROD-01) : les recherches de
  patients et de courses passent dans l'URL (`/patients?q=Dupont`). nginx doit donc journaliser
  l'URL sans sa query string (`$uri` et non `$request` dans `log_format`), sinon les noms
  recherchés se retrouvent dans les journaux d'accès, hors des protections de la base.
- **En-têtes** : Content-Security-Policy avec nonce par requête, Permissions-Policy,
  Cross-Origin-Opener-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy ; en production aussi HSTS (2 ans,
  sous-domaines inclus). En production, le cookie de session s'appelle `__Host-ot_session` et le
  serveur s'arrête au démarrage si `SESSION_SECRET` est l'exemple fourni ou fait moins de 43
  caractères (`openssl rand -base64 48`).
- **Mode démo** (`DEMO_MODE=1`, à ne jamais poser en production) : l'image Docker charge le jeu fictif
  sur une base vide et affiche le bandeau « DÉMO — données fictives ». Sans lui (par défaut dans
  l'image), la base reste vide au premier démarrage, et en production le serveur s'arrête s'il trouve
  un compte `@opti-taxi.test` (comptes du seed, mots de passe publics). Attention : `docker-compose.yml`
  est la démonstration et pose `DEMO_MODE=1` par défaut sur le service `web`. Un déploiement de
  production construit à partir de ce fichier (lot PROD-01) doit donc poser `DEMO_MODE=0`, dans son
  `.env` ou son fichier de surcharge ; sinon il chargerait le jeu fictif et ses mots de passe publics
  sur la base vide. L'ancienne variable `DEMO_DATA` n'est plus lue.
- **Scripts de développement** : `pnpm db:seed`, `pnpm db:reset` et `pnpm db:history` refusent une
  base qui n'est pas sur cette machine ou qui contient des comptes étrangers au jeu fictif
  (`SEED_ALLOW_WIPE=1` pour passer outre, jamais avec `NODE_ENV=production`).

## Limites connues

- **Distances** : sans OSRM, les temps et distances sont estimés à vol d'oiseau (× 1,3 et vitesses
  moyennes), ce que l'interface signale. Cette estimation est optimiste : sur trois journées du jeu
  fictif, les kilomètres routiers d'OSRM sont 13 à 19 % plus élevés. Brancher OSRM (voir
  « Itinéraires routiers précis ») avant tout usage réel.
- **Trafic** : des facteurs moyens par zone et par créneau, pas le trafic réel du jour (accident,
  travaux). Les valeurs par défaut ne sont pas mesurées, et la liste des zones n'est pas modifiable
  dans l'interface (facteurs et rayon le sont). Près d'une limite de créneau, un trajet peut prendre
  le facteur du créneau voisin.
- **Temps de calcul** : 10 s par défaut, relevés automatiquement pour les grosses journées
  (1 s pour 8 courses, 600 s au plus). Sur une machine chargée, quelques courses peuvent rester non
  affectées : relancer « Optimiser demain » ou augmenter le temps dans Paramètres.
- **Marge estimée** : sur les données fictives, elle est proche de zéro ou négative (de l'ordre de
  −5 000 € sur les 20 jours simulés), car le coût horaire des chauffeurs est compté sur toute
  l'amplitude de la tournée et les grilles tarifaires du seed sont inventées. Elle ne vaut que par
  comparaison entre deux plannings ; les vraies grilles CPAM et les vrais coûts se saisissent dans
  Tarifs, Véhicules et Chauffeurs.
- **Limites de débit** (connexion, géocodage) : en mémoire, valables pour une seule instance du web.
  Sur l'hébergeur HDS, les compléter au niveau du proxy : nginx `limit_req` sur toutes les requêtes
  POST (une Server Action répond à n'importe quelle URL de page, une règle sur `POST /login` seule se
  contourne), `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, `next start -H 127.0.0.1`,
  `TRUSTED_PROXY_HOPS=1`, et HTTPS obligatoire (le cookie de session est Secure). Exemple de
  configuration en tête de `apps/web/src/lib/auth/rate-limit.ts`.
- **Journal d'audit** : pas encore d'écran pour le consulter (Prisma Studio ou SQL).

## Hors périmètre du MVP

Facturation CPAM et télétransmission, prise d'appels, transports d'urgence. Version 2 envisagée :
réoptimisation en journée, suivi GPS, SMS aux patients, alertes de fin de prescription, durées apprises
sur l'historique, export vers le logiciel de facturation.
