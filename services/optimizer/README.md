# Service d'optimisation (FastAPI + OR-Tools)

Calcule les tournées J+1 de la flotte (taxi conventionné, VSL, ambulance) et évalue les plannings
ajustés à la main par le régulateur. Contrat d'échange avec le web : [`contract/README.md`](../../contract/README.md)
(modèles pydantic dans [`app/schemas.py`](app/schemas.py), exemples dans `contract/fixtures/`).

| Route | Rôle |
| --- | --- |
| `GET /health` | sonde ; indique la source des distances (`osrm` ou `haversine`) |
| `POST /optimize` | `OptimizeRequest` → `PlanResponse` : tournées de la journée |
| `POST /evaluate` | `EvaluateRequest` → `PlanResponse` : horaires, km, CA et violations d'un planning donné |

Une requête invalide est refusée en **422** (validation pydantic). Chaque réponse contient le
résultat du **validateur indépendant** (`validation.valid`, `validation.violations`).

## Lancer en local (Windows, venv du dépôt)

```bash
cd services/optimizer
python -m venv .venv                       # une seule fois
.venv/Scripts/python.exe -m pip install -e ".[dev]"
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8100
# http://localhost:8100/health  — documentation interactive : http://localhost:8100/docs
```

Variables d'environnement :

| Variable | Effet |
| --- | --- |
| `OSRM_URL` | ex. `http://localhost:5050` : temps et distances routiers via OSRM. Vide : estimation à vol d'oiseau. |
| `LOG_LEVEL` | `info` par défaut (temps de calcul de chaque requête dans les journaux). |

Tests (~1 min, dont le démarrage de l'interpréteur) :

```bash
.venv/Scripts/python.exe -m pytest -q
```

Docker (image `python:3.12-slim`, utilisateur non root, port 8100) :

```bash
docker compose up -d --build optimizer
```

## Organisation du code

| Module | Contenu |
| --- | --- |
| `app/matrix.py` | matrice temps/distances : OSRM (`/table`, par blocs de 100 points, délai 10 s) avec repli automatique sur l'estimation à vol d'oiseau ; points identiques dédoublonnés |
| `app/pricing.py` | grille tarifaire (type + département, repli sur `"*"`), CA d'une course, abattement de partage |
| `app/model.py` | fenêtres horaires dérivées (source unique), paires aller/retour d'un patient, compatibilité véhicule, mode de pause |
| `app/solver.py` | modèle OR-Tools (PDPTW) et recherche |
| `app/schedule.py` | horaires d'une séquence d'arrêts donnée (au plus tôt, puis sans attente patient à bord), placement de la pause |
| `app/plan.py` | assemblage de la réponse : horaires, km à vide / en charge, partage, CA, coût, marge |
| `app/validator.py` | validateur indépendant des contraintes dures (codes de violation du contrat) |
| `app/kpis.py` | indicateurs de la journée |
| `app/service.py`, `app/main.py` | opérations `optimize` / `evaluate` et API HTTP |

## Choix de modélisation

**Distances.** Avec OSRM : durée arrondie à la minute supérieure, distance en km. Sans OSRM (ou en
cas d'erreur OSRM, signalée dans `meta.warnings`) : km routiers = distance orthodromique × 1,3 ;
minutes = 10 premiers km à 30 km/h puis 85 km/h, arrondi à la minute supérieure.

**Fenêtres horaires** (une seule source : `model.py`, utilisée par le solveur et par le calcul des
horaires) : dépose d'un aller dans `[RDV − attente avant, RDV]`, prise en charge d'un retour dans
`[fin de séance, fin de séance + attente après]`, autres arrêts libres dans l'horaire du véhicule.
Si `attente avant + attente après` dépasse l'attente cumulée maximale, les fenêtres de la paire
aller/retour du même patient sont resserrées (la marge avant le RDV est prioritaire) : toute
solution respecte alors l'attente cumulée.

**Solveur (OR-Tools, ramassage et livraison avec fenêtres horaires).**

- Un nœud dépôt par véhicule (départ et retour), deux nœuds par course (prise en charge, dépose)
  liés par `AddPickupAndDelivery`, même véhicule, prise en charge avant dépose.
- Types de véhicule prescrits et course figée : domaine de la variable véhicule des deux nœuds
  (la méthode `SetAllowedVehiclesForIndex` n'est pas appelable depuis Python dans cette version
  d'OR-Tools ; restreindre le domaine a le même effet).
- Places : dimension de capacité. Patient non partageable : seconde dimension « exclusivité » où il
  pèse toute la capacité du véhicule, personne d'autre ne peut monter tant qu'il est à bord.
- Horaires : dimension temps en minutes (temps d'arrêt inclus, attente autorisée), fenêtres des
  arrêts, horaires de service du véhicule.
- Détour : limite « prise en charge → dépose » sur la dimension distance (mètres,
  `SetPickupToDeliveryLimitFunctionForPair`) ; pour une course partageable,
  `trajet réel ≤ direct + min(détour par co-passager, détour maximal)`. Un trajet partagé compte au
  moins un co-passager : la borne est donc toujours valide (exactement la règle des 10 km pour un
  véhicule à 2 places, prudente au-delà).
- Pause chauffeur : un nœud « pause » par lieu candidat (dépôt du véhicule et établissements des
  courses qu'il peut faire, au plus 12), réservé au véhicule, dans la fenêtre de pause, avec un
  temps d'arrêt égal à la durée de la pause et **aucun patient à bord** (cumul de places forcé à 0) ;
  un seul est visité. Le trajet jusqu'au lieu de pause est compté. Si l'horaire du véhicule laisse
  toujours la pause avant le départ ou après le retour, aucun nœud n'est créé.
- Toutes ces règles passent par des primitives du routage (dimensions, limite prise en charge →
  dépose, domaine des véhicules, disjonctions) que les filtres d'OR-Tools vérifient à chaque
  insertion et à chaque mouvement. Une contrainte posée sur les cumuls par `solver.Add()` n'est
  vérifiée qu'après coup par propagation : écrits ainsi, le détour et les précédences rendaient la
  première solution d'une journée de 160 courses 5 à 7 fois plus lente (6 à 10 s au lieu de
  1,5 s).
- Objectif (centimes) : km × coût/km par véhicule ; minutes de tournée × coût/h ÷ 60 ; CA perdu
  par rapport au type de véhicule le mieux payé pour la course (sur l'arc qui quitte la prise en
  charge) ; course non affectée = pénalité + son meilleur CA (doublée pour une course figée) ;
  pause non prise = pénalité supérieure à toutes les courses réunies.
- Recherche (tout est compté dans `timeLimitSec`, construction du modèle et matrice en plus) :
  1. première solution `PARALLEL_CHEAPEST_INSERTION`, **menée à son terme**, quitte à dépasser le
     budget de 5 s au plus (interrompue, elle laisse la plupart des courses de côté : aucune des
     160 courses de la journée chargée avec un budget de 1 s) ;
  2. réparation des pauses : un véhicule resté sans pause la reçoit à la position vide la moins
     coûteuse ; si aucune n'est possible, on retire la course la moins chère dont le retrait
     suffit, sinon celle qui traverse le plus la fenêtre de pause, et on recommence. Vérifications
     exactes en Python (horaires, détours ; quelques millisecondes), puis une confirmation par le
     modèle OR-Tools ;
  3. `GUIDED_LOCAL_SEARCH` sur le reste du budget, à partir de ce planning où toutes les pauses
     sont prises.
- Motif des courses non placées par le solveur : si la recherche locale a atteint un optimum
  local, « Pas de place dans les tournées… » ; si elle a été interrompue par la limite de temps
  (statut `ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED`), « Non placée dans le temps de
  calcul imparti… » et un avertissement dans `meta.warnings` donne le nombre de courses concernées
  et le temps conseillé.

**Après le solveur, tout est recalculé** à partir de l'ordre des arrêts (`schedule.py`) :
horaires au plus tôt, puis report des arrêts suivis d'un trajet avec patient à bord pour éviter
toute attente patient dans le véhicule ; départ du dépôt le plus tard possible sans retarder le
premier arrêt ; pause placée avant le départ, sur un trajet à vide ou après le retour (la moins
pénalisante, puis la plus tôt) ; km à vide (dépôt compris), km en charge, partage et co-passagers,
CA avec abattement, coût `km × coût/km + durée/60 × coût/h`, marge et indicateurs.

**`/evaluate`** prend les séquences telles quelles : références inconnues ignorées
(`UNKNOWN_REFERENCE`), arrêts répétés gardés une fois (`DUPLICATE_TRIP`), horaires au plus tôt,
puis validation. Les courses absentes du planning sont « Non planifiée ». Une pause qui
retarderait un patient n'est pas placée : la violation `BREAK` est signalée à la place.

**Validateur** (`validator.py`) : indépendant du solveur et du calcul des horaires, il revérifie à
partir de la requête, de la matrice et des tournées produites (avec leurs horaires) chaque règle :
`UNKNOWN_REFERENCE`, `DUPLICATE_TRIP`, `PAIRING`, `LOCK`, `VEHICLE_TYPE`, `CAPACITY`,
`EXCLUSIVE_RIDE`, `TIME_WINDOW` (dont horaires intenables vu les temps de trajet), `TOTAL_WAIT`,
`DETOUR`, `SHIFT`, `BREAK`. Tolérances : 0,05 km sur les distances ; 0 minute sur les horaires
(minutes entières, calcul exact).

## Limites connues

- **Temps de calcul.** Journée chargée de référence (`busy_day()` des tests : 160 courses,
  16 véhicules dont 14 avec pause, distances à vol d'oiseau, machine de développement) :

  | Budget | Courses servies |
  | --- | --- |
  | 1 s | 116 (réponse en 2,5 s : la première solution finit hors budget) |
  | 5 s | 116 |
  | 10 s (défaut du web) | 116 (74 avant la correction de la recherche) |
  | 30 s | 134 |
  | 10 s sans aucune pause | 125 |

  La première solution prend environ 1,5 s ; la réparation des pauses retire ~9 courses, que la
  recherche locale ne replace qu'avec du temps. **Temps conseillé : max(10 s, 1 s par 8 courses)**
  (20 s pour 160 courses) ; l'avertissement « Recherche interrompue… » l'indique. Le web passe
  `solverTimeLimitSec` tel quel (10 s par défaut) : le faire croître avec le nombre de courses est
  une évolution demandée côté web. `tests/test_solver_quality.py` vérifie qu'à 10 s on sert au
  moins 80 % de ce qu'atteint un calcul de 30 s (comparaison directe :
  `OPTIMIZER_SLOW_TESTS=1`).
- La réparation des pauses est gloutonne (une pause par véhicule, au moindre détour) : elle peut
  retirer une course qu'une réorganisation des tournées aurait gardée ; la recherche locale peut
  ensuite la replacer.
- **Écart objectif / coût affiché autour de la pause.** Dans le modèle, la pause d'une tournée qui
  finit avant la fenêtre de pause (ou commence après) reste dans la fenêtre (lieu de pause visité
  à partir de 11:30 par exemple) : l'objectif paie l'attente jusqu'à la fin de cette pause
  (≈ 24 €/h × attente), alors que le planning recalculé place la pause après le retour et affiche
  la tournée courte. Le solveur surestime donc un peu les tournées du matin seul / de l'après-midi
  seul ; un véhicule non utilisé porte sa pause au dépôt (coût constant, sans effet sur les
  choix). Des nœuds « pause avant le départ » / « pause après le retour » gratuits suppriment cet
  écart mais figent la tournée d'un côté de la fenêtre (y ajouter une course de l'autre côté
  demande un mouvement composé que la recherche locale ne fait pas) : essayés sur la journée
  chargée, ils servaient autant de courses à 10 s (116) et moins à 30 s (132 contre 135), et
  pouvaient laisser deux véhicules échangés. Écart mesuré par
  `test_objective_gap_of_a_route_ending_before_the_break_window`.
- L'abattement de partage n'entre pas dans l'objectif du solveur (non linéaire) : il favorise un
  peu plus le partage que la marge réelle ; le CA renvoyé, lui, applique l'abattement.
- Pour un véhicule de 3 places ou plus, le détour autorisé par le solveur reste celui d'un seul
  co-passager (prudent).
- Lieux de pause candidats limités au dépôt et aux 11 établissements les plus proches du dépôt.
- Pas de trafic : OSRM donne des temps sans congestion ; l'estimation à vol d'oiseau est grossière
  en montagne.
- La recherche locale tourne tout le temps imparti (`timeLimitSec`) : la réponse arrive après ce
  délai, plus le calcul de la matrice et la construction du modèle (~0,5 s pour 160 courses), et
  au plus 5 s de plus si la première solution n'a pas fini dans le budget (le web attend
  `timeLimitSec` + 30 s).
- Matrices et modèle construits en Python en O(n²) : adapté à quelques centaines de courses par
  jour (taille de la flotte de V) ; au-delà, prévoir des voisinages restreints.
