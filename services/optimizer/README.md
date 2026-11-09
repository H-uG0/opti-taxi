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
| `OPTIMIZER_TOKEN` | jeton partagé avec le web : toutes les adresses sauf `/health` (`/optimize`, `/evaluate`, `/docs`, `/openapi.json`) exigent `Authorization: Bearer <jeton>` (sinon `401`, avant toute lecture de la requête). Vide : aucun contrôle, signalé au démarrage (développement seulement). Générer avec `openssl rand -base64 32`. |
| `OPTIMIZER_MAX_CONCURRENT_SOLVES` | calculs simultanés, 2 par défaut (1 à 8) ; au-delà, `/optimize` répond `429` (« réessayez dans une minute » côté web). Un calcul à 120 véhicules occupe 2 à 4 Go. |
| `OPTIMIZER_MAX_BODY_MB` | taille maximale d'une requête, 10 Mo par défaut (sinon `413`). |

Tests (~2 min sur la machine de développement ; `tests/test_search.py` lance trois interpréteurs,
un par valeur de `PYTHONHASHSEED`) :

```bash
.venv/Scripts/python.exe -m pytest -q
```

Banc de charge, lancé à la main (une journée fictive à l'échelle de V, un `optimize` puis un
`evaluate`, résultat en JSON : courses servies, temps de chaque phase, mémoire) :

```bash
.venv/Scripts/python.exe -m tests.bench_fleet --vehicles 120 --trips 300 --budget 38
```

Banc de qualité de la recherche (requêtes de journées enregistrées, ou journées fictives
`busy:<graine>` / `generated:<graine>` ; par journée : courses servies, patients à moitié servis,
marge, score de l'objectif, violations ; `--warm` envoie un planning comme planning en place) :

```bash
.venv/Scripts/python.exe -m tests.bench_days req-2026-11-10.json busy:11 generated:7 --budget 10
```

Docker (image `python:3.12-slim`, utilisateur non root, port 8100) :

```bash
docker compose up -d --build optimizer
```

## Organisation du code

| Module | Contenu |
| --- | --- |
| `app/matrix.py` | matrice temps/distances : OSRM (`/table`, par blocs de 100 points, délai 10 s) avec repli automatique sur l'estimation à vol d'oiseau ; points identiques dédoublonnés |
| `app/traffic.py` | temps de trajet par créneau : `TrafficProvider` remplit une table de minutes par créneau (`ZoneFactors` aujourd'hui, une API de trafic demain), minute de référence de chaque arrêt |
| `app/pricing.py` | grille tarifaire (type + département, repli sur `"*"`), CA d'une course, abattement de partage |
| `app/model.py` | fenêtres horaires dérivées (source unique), paires aller/retour d'un patient, compatibilité véhicule, mode de pause |
| `app/solver.py` | modèle OR-Tools (PDPTW) et recherche |
| `app/schedule.py` | horaires d'une séquence d'arrêts donnée (au plus tôt, puis sans attente patient à bord), placement de la pause |
| `app/plan.py` | assemblage de la réponse : horaires, km à vide / en charge, partage, CA, coût, marge |
| `app/validator.py` | validateur indépendant des contraintes dures (codes de violation du contrat) |
| `app/kpis.py` | indicateurs de la journée |
| `app/service.py`, `app/main.py` | opérations `optimize` / `evaluate` et API HTTP |
| `app/security.py` | jeton d'accès, nombre de calculs simultanés, taille des requêtes |

## Choix de modélisation

**Distances.** Avec OSRM : durée arrondie à la minute supérieure, distance en km. Sans OSRM (ou en
cas d'erreur OSRM, signalée dans `meta.warnings`) : km routiers = distance orthodromique × 1,3 ;
minutes = 10 premiers km à 30 km/h puis 85 km/h, arrondi à la minute supérieure.

**Fenêtres horaires** (une seule source : `model.py`, utilisée par le solveur et par le calcul des
horaires) : dépose d'un aller dans `[RDV − attente avant, RDV]`, prise en charge d'un retour dans
`[fin de séance, fin de séance + attente après]`, autres arrêts libres dans l'horaire du véhicule.
Si `attente avant + attente après` dépasse l'attente cumulée maximale, les fenêtres de la paire
aller/retour du même patient sont resserrées (la marge avant le RDV est prioritaire) : toute
solution respecte alors l'attente cumulée. Un trajet sans son pendant attend au plus l'attente
cumulée maximale.

**Attente à bord devant le lieu de soins** (décret 2025-202, art. R. 322-11-6). Le véhicule peut
rester garé devant l'établissement avec un patient à bord : il attend l'heure d'un autre patient
(retour partagé d'une dialyse : A prêt à 11:00, pris à 11:15, B prêt à 11:30) ou l'ouverture de la
fenêtre de dépose. Ces minutes comptent dans l'attente du patient (aller avant sa dépose, retour
après sa prise en charge) ; le temps de montée ou de descente des autres patients, non. Le
solveur garde chaque trajet dans sa fenêtre, attente à bord comprise (« Vérification finale »
ci-dessous) ; le validateur vérifie le total.

**Temps à bord** : de la fin de la prise en charge au début de la dépose, au plus le trajet direct
(aux minutes de référence de la course) + `maxRideExtraMin` (30 min par défaut, réglable).

**Temps d'arrêt par course** : `trips[].pickupServiceMin` / `dropoffServiceMin` quand le web les
envoie (mode de transport, mobilité, établissement), sinon ceux de `settings`.

**Pause de 20 min dès 6 h de travail** (Code du travail, art. L. 3121-16). Une tournée (départ du
dépôt → retour) de plus de 6 h doit contenir une pause d'au moins 20 min. Un véhicule dont la
pause ne la garantit pas (pas de pause, pause de moins de 20 min, ou pause toujours avant le
départ ou après le retour) a des tournées limitées à 6 h (`model.work_limit_min`,
`SetSpanUpperBoundForVehicle`, même borne en Python, horaires calculés au plus serré, voir
`schedule.py`). Le web bloque d'ailleurs un tel équipage sur Équipages dès que son horaire dépasse
6 h. L'amplitude et le repos quotidiens de l'accord de V restent à modéliser (TT-01).

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
- Temps à bord (trajet direct + `maxRideExtraMin`) et attente à bord devant le lieu de soins :
  vérifiés par les étapes en Python (insertion, réparations) et par la vérification finale sur les
  horaires que calcule `schedule.py`, pas par le modèle OR-Tools. Jusqu'au lot OPT-08, le temps à
  bord était aussi une limite « prise en charge → dépose » sur la dimension temps
  (`SetPickupToDeliveryLimitFunctionForPair`) : sur cette dimension, dont la marge est l'attente,
  les filtres d'OR-Tools la vérifient à un coût tel que la première solution d'une journée chargée
  prenait 14 s au lieu de 1 s (`busy_day(seed=13)` : 118 courses servies au lieu de 128 à 10 s),
  et elle bridait la recherche locale (12/11 de la démo : marge −744 € au lieu de −444 €, même
  nombre de courses). La règle reste entière : aucun planning renvoyé ne la dépasse.
- Détour : limite « prise en charge → dépose » sur la dimension distance (mètres,
  `SetPickupToDeliveryLimitFunctionForPair`) ; pour une course partageable,
  `trajet réel ≤ direct + min(détour par co-passager, détour maximal)`. Un trajet partagé compte au
  moins un co-passager : la borne est donc toujours valide (exactement la règle des 10 km pour un
  véhicule à 2 places, prudente au-delà).
- Pause chauffeur : un nœud « pause » par lieu candidat (dépôt du véhicule et établissements des
  courses qu'il peut faire, au plus 12 ; plus les domiciles où finit un retour de midi quand aucun
  autre lieu n'est atteignable à temps, voir « Limites connues »), réservé au véhicule, dans la
  fenêtre de pause, avec un temps d'arrêt égal à la durée de la pause et **aucun patient à bord**
  (cumul de places forcé à 0) ; un seul est visité. Le trajet jusqu'au lieu de pause est compté.
  Si l'horaire du véhicule laisse toujours la pause avant le départ ou après le retour, aucun nœud
  n'est créé.
- Les règles du modèle passent par des primitives du routage (dimensions, limite prise en charge →
  dépose, domaine des véhicules, disjonctions) que les filtres d'OR-Tools vérifient à chaque
  insertion et à chaque mouvement. Une contrainte posée sur les cumuls par `solver.Add()` n'est
  vérifiée qu'après coup par propagation : écrits ainsi, le détour et les précédences rendaient la
  première solution d'une journée de 160 courses 5 à 7 fois plus lente (6 à 10 s au lieu de
  1,5 s).
- Objectif (millièmes de centime ; `meta.objective` en centimes) : km × coût/km par véhicule ;
  minutes de tournée × coût/h ÷ 60 ; CA perdu par rapport au type de véhicule le mieux payé pour la
  course (sur l'arc qui quitte la prise en charge) ; course non affectée = pénalité + son meilleur
  CA (doublée pour une course figée) ; pause non prise = pénalité supérieure à toutes les courses
  réunies. **Aller et retour d'un patient** : laisser l'un sans véhicule pendant que l'autre est
  servi coûte une pénalité de non-affectation de plus, payée une fois par paire
  (`AddDisjunction([aller, retour], pénalité, 2, PENALIZE_ONCE)`) : le solveur préfère laisser une
  course isolée mieux payée qu'un patient au lieu de soins sans retour. À coût égal, une paire
  passe donc aussi avant deux courses isolées. La priorité médicale par type de soin relève
  d'OBJ-02 (décision du PO).
- Coût au km : les arcs portent les km au coût au km le plus bas de la flotte, plus le CA perdu,
  avec une matrice par grille tarifaire (au plus une par type de véhicule et département) ; le reste
  du coût au km de chaque véhicule est un coût d'étendue de la dimension distance
  (`SetSpanCostCoefficientForVehicle`, par mètre). Avant, une matrice dense par coût au km distinct
  (32 Mo à 2 000 nœuds, jusqu'à 60 clés sur le banc) : aucun coût propre à un véhicule ne doit
  revenir dans un évaluateur d'arc (préférences du lot 6, énergie du lot 5).
- Recherche (tout est compté dans `timeLimitSec`, **construction du modèle comprise**, matrice en
  plus : à 120 véhicules, construire le modèle prend 9 s pour 300 voyages, 18 s pour 480) :
  1. départs construits en Python, **en premier**, chacun confirmé aussitôt par le modèle OR-Tools
     (`ReadAssignmentFromRoutes`, 0,1 s), avant tout calcul : après un calcul qui a épuisé sa
     limite de temps, cette confirmation échoue. Ils peuvent dépasser le budget de 5 s au plus :
     a. le **planning en place** réparé, quand le web l'envoie (`initialRoutes`, voir « Planning en
        place » ci-dessous) ;
     b. l'insertion depuis les pauses : les pauses seules (au dépôt), puis toutes les courses par
        l'insertion avec regret de l'étape 4 (le retour d'un aller servi, puis l'aller d'un retour
        servi, d'abord) ;
     c. quand une recherche locale suivra (étape 2 lancée), la même insertion **par regret seul**,
        sans faire passer d'abord l'autre trajet d'un patient servi : les deux ordres mènent la
        recherche à des plannings différents, chacun meilleur sur deux des quatre journées de la
        démonstration (journal, OPT-08) ;
  2. première solution `PARALLEL_CHEAPEST_INSERTION`, **menée à son terme**, quitte à dépasser le
     budget de 5 s au plus (interrompue, elle laisse la plupart des courses de côté : aucune des
     160 courses de la journée chargée avec un budget de 1 s). Son temps croît comme le cube du
     nombre de nœuds (environ 8·10⁻⁹ × nœuds³ s sur la machine de développement) : 0,9 s pour la
     journée chargée (476 nœuds), 60 s pour 120 véhicules et 300 voyages (2 000 nœuds). **Quand
     cette loi prédit qu'elle ne peut pas finir dans le temps qui reste** (plus la marge de 5 s),
     elle n'est pas lancée : le planning est le moins coûteux des départs Python, renvoyé aussitôt,
     sans recherche locale (elle ne gagnait que 1 % de km en 10 min à cette taille ;
     `solverStatus` = `INSERTION`) ;
  3. réparation des pauses : un véhicule resté sans pause la reçoit à la position vide la moins
     coûteuse ; si aucune n'est possible, on retire la course la moins chère dont le retrait
     suffit, sinon celle qui traverse le plus la fenêtre de pause, et on recommence ;
  4. réinsertion : chaque course laissée de côté (par la réparation, par la première solution, ou
     dont un patient y attendait à bord au-delà de sa fenêtre) revient à sa position faisable la
     moins coûteuse, par insertion avec regret : d'abord le retour dont l'aller est servi, puis
     l'aller dont le retour est servi, puis la course qui n'a qu'une possibilité, puis celle dont le
     meilleur et le deuxième meilleur véhicule diffèrent le plus. Si une course ne tient qu'en
     déplaçant la pause du véhicule, la pause est retirée puis replacée (autre lieu, autre position
     vide) ;
  5. `GUIDED_LOCAL_SEARCH` **depuis chaque départ** (1 à 4, doublons écartés) pendant un temps
     court (la moitié du temps restant, partagée), puis depuis le meilleur planning trouvé jusqu'à
     la fin du budget. La recherche locale replace rarement une course que son départ a laissée de
     côté : c'est le départ qui décide où elle aboutit, et le départ le moins coûteux n'est pas
     celui qui aboutit le mieux (le 10/11 de la démonstration : la première solution, 57 courses,
     était moins coûteuse que l'insertion, 56, et restait à 57 ; depuis l'une ou l'autre insertion,
     la recherche atteint 59 courses en une seconde environ). Avant OPT-08, seul le départ le moins
     coûteux était cherché. Moins de 0,5 s par départ : le moins coûteux seul.

  Étapes 1, 3 et 4 : vérifications exactes en Python (horaires au plus tôt et au plus tard,
  places, patient non partageable seul à bord, véhicule vide pendant la pause, détours, durée de
  tournée sans pause, et sur les horaires que `schedule.py` calculera : temps à bord et attente à
  bord devant le lieu de soins ; de 0,1 à 1 s pour 60 à 160 courses, 5 s pour 300 voyages à 120
  véhicules), puis une confirmation de chaque planning par le modèle OR-Tools. Sans elles, la
  recherche locale mettait de 5 à plus de 120 s à replacer les courses retirées par la réparation
  des pauses (mesures dans « Limites connues »).
- **Vérification finale** (`_DayModel.guarded`). Le modèle OR-Tools ne borne l'attente à bord que
  par le temps à bord, sur les horaires qu'il choisit ; le planning renvoyé est minuté par
  `schedule.py`. Chaque tournée finale est donc minutée comme la réponse : une course dont le
  patient dépasse son temps à bord ou attend à bord au-delà de sa fenêtre, ou une tournée de plus
  de 6 h sans pause, sort de la tournée (la moins chère d'abord) puis est réinsérée là où la même
  vérification passe (5 s au plus), à égalité de coût la course d'identifiant le plus petit (le
  choix ne dépend pas de `PYTHONHASHSEED`). Une course qui ne trouve pas de place reçoit le motif
  « Pas de place dans les tournées sans dépasser le temps à bord ou l'attente au lieu de soins… »,
  ou, sortie pour la durée de tournée, « Pas de place dans les tournées sans dépasser 6 h de
  travail sans pause de 20 min… ».
- **Patients à moitié servis** (`_DayModel.restore_pairs`, 3 s au plus). Pour chaque aller ou
  retour non placé dont l'autre trajet est servi (les retours d'abord), une course qui gêne et
  coûte moins à laisser (course isolée, ou dont le patient n'a pas non plus son autre trajet ;
  jamais l'autre trajet du même patient, qui resterait à moitié servi) sort de sa tournée pour lui
  faire place, puis est réinsérée là où elle tient. La recherche locale
  d'OR-Tools ne fait pas cet échange : sur la journée chargée, la pénalité seule ne réduisait pas le
  nombre de patients à moitié servis.
- **Planning en place** (`initialRoutes`, contrat). Quand la date a déjà des tournées, le web les
  envoie ; l'optimizer les répare selon les règles de la requête (`_DayModel._from_plan` : courses
  d'un véhicule inconnu ou d'un type non autorisé, dépose avant prise en charge, places, transport
  exclusif, détour, temps et attente à bord, horaires, 6 h sans pause : la course fautive sort ;
  pause placée ; courses sorties ou non servies réinsérées), s'en sert comme départ (étape 1.a), et,
  après la vérification finale, compare le planning de la recherche à ce planning réparé (passé
  par la même vérification) : le meilleur au sens de l'objectif (`_DayModel.plan_score` : courses
  non affectées, patients dont l'aller et le retour ne sont pas tous deux servis, puis marge
  recalculée comme la réponse, abattement de partage compris) est renvoyé. Réoptimiser une date
  où rien n'a changé rend donc un planning au moins aussi bon que celui en place
  (`test_reoptimizing_a_planned_day_without_change_is_at_least_as_good`), et le web ne pose plus
  « Remplacer quand même ? » dans ce cas. Réparer le planning en place prend quelques
  millisecondes à 60 courses.
- **Première solution coupée par sa limite** (grande flotte : à 120 véhicules et 300 voyages, aucune
  course placée en 33 s) : le départ Python, moins coûteux, l'emporte. Avant que ce départ passe en
  premier, la réponse était un planning vide.
- **Première solution introuvable** (`ROUTING_FAIL_TIMEOUT` : la limite de temps tombe avant que
  l'heuristique produise quoi que ce soit, sur une machine surchargée) : au lieu de répondre
  `NO_SOLUTION`, la recherche locale part du moins coûteux des départs Python (ou des pauses
  seules, toujours faisable, si OR-Tools les a tous refusés) pour le reste du budget, au moins 5 s.
- Dans ces deux cas, s'il reste des courses non placées, un avertissement (« Construction initiale
  des tournées interrompue… planning construit par une méthode de secours… ») le signale dans
  `meta.warnings`.
- Motif des courses non placées par le solveur : si la recherche locale a atteint un optimum
  local, « Pas de place dans les tournées… » ; si elle a été interrompue par la limite de temps
  (statut `ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED`) ou si le planning vient de la
  méthode de secours ci-dessus, « Non placée dans le temps de calcul imparti… » et un
  avertissement dans `meta.warnings` donne le nombre de courses concernées et le temps conseillé.
- **Déterminisme.** Nœuds, candidats et étapes Python parcourent des listes et des dictionnaires
  (ordre d'insertion), jamais des ensembles : le modèle et, à nombre de solutions fixé, le
  planning ne dépendent pas de `PYTHONHASHSEED` (`test_model_and_plan_do_not_depend_on_the_hash_seed`,
  trois interpréteurs). Seules la limite de temps et la limite de 100 ms des sous-recherches LNS
  d'OR-Tools peuvent faire différer deux calculs.

**Après le solveur, tout est recalculé** à partir de l'ordre des arrêts (`schedule.py`) :
horaires au plus tôt, puis report des arrêts suivis d'un trajet avec patient à bord pour réduire
l'attente patient dans le véhicule (elle reste quand une fenêtre se ferme avant l'ouverture de la
suivante : c'est l'attente à bord que comptent le solveur et le validateur) ; départ du dépôt le
plus tard possible sans retarder le premier arrêt ; pause placée avant le départ, sur un trajet à
vide ou après le retour (la moins pénalisante, puis celle qui garde une tournée de plus de 6 h
légale, puis la plus courte, puis la plus tôt) ; une tournée de plus de 6 h sans pause légale est
minutée au plus serré (chaque arrêt le plus tard possible) ; km à vide (dépôt compris), km en
charge, partage et co-passagers, CA avec abattement, coût `km × coût/km + durée/60 × coût/h`,
marge et indicateurs.

**`/evaluate`** prend les séquences telles quelles : références inconnues ignorées
(`UNKNOWN_REFERENCE`), arrêts répétés gardés une fois (`DUPLICATE_TRIP`), horaires au plus tôt,
puis validation. Les courses absentes du planning sont « Non planifiée ». Une pause qui
retarderait un patient n'est pas placée : la violation `BREAK` est signalée à la place.

**Validateur** (`validator.py`) : indépendant du solveur et du calcul des horaires, il revérifie à
partir de la requête, de la matrice et des tournées produites (avec leurs horaires) chaque règle :
`UNKNOWN_REFERENCE`, `DUPLICATE_TRIP`, `PAIRING`, `LOCK`, `VEHICLE_TYPE`, `CAPACITY`,
`EXCLUSIVE_RIDE`, `TIME_WINDOW` (dont horaires intenables vu les temps de trajet et temps d'arrêt
propres à chaque course), `TOTAL_WAIT` (attente à bord devant le lieu de soins comprise, par paire
aller/retour et pour un trajet seul), `RIDE_TIME`, `DETOUR`, `SHIFT`, `BREAK` (dont tournée de plus
de 6 h sans pause de 20 min, art. L. 3121-16). Tolérances : 0,05 km sur les distances ; 0 minute sur
les horaires (minutes entières, calcul exact).

## Limites connues

- **Temps de calcul.** Journées du jeu de démonstration (requêtes construites par le web depuis la
  base de développement, 10 véhicules, tous avec pause, distances à vol d'oiseau, machine de
  développement chargée) : courses servies, avant → après la réinsertion, le second départ et les
  pauses au domicile (le calcul de 120 s d'avant ne faisait pas mieux que celui de 60 s) :

  | Journée | 5 s | 10 s (défaut du web) | 30 s | 60 s |
  | --- | --- | --- | --- | --- |
  | 03/11 (64 courses) | 57 → 63 | 61 → 63 ou 64 (selon la charge) | 61 → 64 | 61 → 64 |
  | 04/11 (60 courses) | 54 → 60 | 58 → 60 | 59 → 60 | 59 → 60 |
  | 05/11 (56 courses) | 50 → 56 | 54 → 56 | 55 → 56 | 55 → 56 |

  Qualité de la recherche (OPT-08, 9 novembre ; requêtes de la démo en ligne, 10 s, courses servies
  / patients à moitié servis / marge) : avant le lot conformité (7a172cf, anciennes règles), après
  lui (97d94a2), et depuis OPT-08 (départs multiples, temps à bord hors du modèle) :

  | Journée | 7a172cf | 97d94a2 | OPT-08 |
  | --- | --- | --- | --- |
  | 10/11 (60 courses) | 58 / 2 / −132 € | 57 / 3 / −520 € | 59 / 1 / −264 € |
  | 11/11 (60 courses) | 55 / 1 / −134 € | 55 / 1 / −163 € | 55 / 1 / −46 € |
  | 12/11 (54 courses) | 52 / 2 / −785 € | 52 / 2 / −744 € | 52 / 2 / −444 € |
  | 13/11 (56 courses) | 55 / 1 / −344 € | 56 / 0 / −513 € | 56 / 0 / −421 à −494 € (selon la charge) |

  Les plannings de 7a172cf ne respectent pas tous les nouvelles règles : réévalués (`/evaluate`), le
  11/11 a 3 `RIDE_TIME` et un `TOTAL_WAIT`, le 13/11 un `RIDE_TIME` et un `TOTAL_WAIT`, le 10/11 un
  `TOTAL_WAIT` ; réparés par le planning en place, ils donnent 58 / 2 / −145 €, 55 / 1 / −131 €,
  52 / 2 / −797 € et 55 / 1 / −479 €. Banc et détails : journal des améliorations, lot OPT-08.

  Journée chargée de référence (`busy_day()` des tests : 160 courses, 16 véhicules dont 14 avec
  pause) :

  | Budget | Avant | Actuel |
  | --- | --- | --- |
  | 1 s | 116 | 129 (réponse en 2,6 s : la première solution finit hors budget) |
  | 5 s | 116 | 129 |
  | 10 s (défaut du web) | 116 | 129 |
  | 20 s (conseillé) | 116 | 129 |
  | 30 s | 134 | 129 à 139 (selon la charge de la machine) |
  | 10 s sans aucune pause | 125 | 132 |

  À 30 s, six calculs ont donné 129 (trois fois), 134, 137 et 139 courses (139 contre 134 pour
  l'ancien code lancé en parallèle, à charge égale). Au-delà de 20 s sur cette journée très chargée (21 à
  31 courses restent non servies), la recherche locale partie des 129 courses de la
  réinsertion progresse encore, mais pas toujours sur une machine chargée, où elle peut rester à
  129 (même résultat avec une insertion « la moins chère d'abord », une réinsertion limitée aux
  courses retirées par la réparation ou d'autres coefficients de la recherche guidée).
  **Temps conseillé : max(10 s, 1 s par 8 courses)** (20 s pour 160 courses) ;
  l'avertissement « Recherche interrompue… » l'indique. Le web envoie min(600, max(`solverTimeLimitSec`, ceil(courses / 8))) (10 s par défaut, voir
  `effectiveTimeLimitSec` dans `apps/web/src/lib/optimizer/build-request.ts` et `contract/README.md`).
  `tests/test_solver_quality.py` vérifie qu'à 10 s on sert au moins 80 % du meilleur résultat
  connu (139) et le compare à un calcul de 30 s avec `OPTIMIZER_SLOW_TESTS=1`.
- La réparation des pauses est gloutonne (une pause par véhicule, au moindre détour) : elle peut
  retirer une course qu'une réorganisation des tournées aurait gardée ; la réinsertion la replace
  quand une position faisable existe, sinon la recherche locale.
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
- Lieux de pause candidats limités au dépôt, aux 11 établissements les plus proches du dépôt et
  aux domiciles où un retour peut finir dans la fenêtre de pause sans qu'aucun autre lieu soit
  atteignable avant le dernier début de pause possible (retour Gap → Sisteron à midi : sans ce
  domicile, la course ou la pause ne trouvait pas de place). Le planning recalculé, lui, peut
  placer la pause sur n'importe quel trajet à vide.
- Trafic moyen, pas celui du jour : des facteurs par zone et par créneau ralentissent des temps sans
  congestion (`settings.traffic`, voir le contrat). Le créneau d'un trajet vient de l'heure attendue de
  ses extrémités, pas de l'heure exacte de passage, inconnue d'une table d'arcs fixe. L'estimation à vol
  d'oiseau reste grossière en montagne.
- La recherche locale tourne tout le temps imparti (`timeLimitSec`, construction du modèle
  comprise ; au moins 1 s de recherche si la construction a pris tout le budget), sauf quand la
  première solution est sautée (grande journée : réponse dès le départ Python prêt) : la réponse
  arrive après ce délai, plus le calcul de la matrice, au plus 5 s de plus si le départ Python
  n'a pas fini dans le budget, 5 s si la première solution non plus, et encore au plus 5 s si
  elle a échoué, plus la vérification finale et les patients à moitié servis quand il y en a
  (au plus 5 + 3 s ; le web attend `timeLimitSec` + 30 s).
- **Grande flotte.** Matrices et modèle sont construits en Python en O(n²), n comptant aussi les
  lieux de pause (jusqu'à 24 par véhicule). À l'échelle annoncée par V (120 véhicules ; `fleet_day()`
  des tests, distances à vol d'oiseau, 1,5 cœur), au budget envoyé par le web :

  | Voyages (budget) | Nœuds (dont pauses) | Modèle | Avant le 7/11 | 7/11 | Depuis le 9/11 | Mémoire 7/11 → 9/11 |
  | --- | --- | --- | --- | --- | --- | --- |
  | 300 (38 s) | 2 000 (1 286) | 13 s → 9 s | 0 course servie, réponse en 60 s | 297 sur 297, en 49 s | 297 sur 297, en 15 s | 1,9 Go → 0,32 Go |
  | 480 (60 s) | 2 884 (1 812) | 27 s → 18 s | 0 course servie, réponse en 102 s | 474 sur 476, en 74 s | 473 sur 476, en 31 s | 4,0 Go → 0,56 Go |

  Depuis OPT-08 (temps à bord hors du modèle OR-Tools, départs multiples), mêmes plannings en
  14,2 s (300 voyages), 30,5 s (480) et 15,6 s (300, tirage 5) : à cette taille, la première
  solution est sautée et une seule insertion est construite (la seconde, par regret seul, ne sert
  qu'à une recherche locale).
  Mesures du 9 novembre sur la machine de développement (8 cœurs, un calcul à la fois). Avec les
  règles d'avant le 9/11 (sans attente à bord, temps à bord ni limite de 6 h), le code du 9/11 rend
  exactement le même planning (mêmes courses, km et CA) en 14 s et 29 s : le gain vient du coût au
  km porté par la dimension distance (une matrice par grille au lieu d'une par coût au km) et de la
  première solution sautée. La course de moins à 480 voyages et le partage plus faible (38 à 40 %
  des courses au lieu de 50 %) viennent des nouvelles règles : les plannings d'avant laissaient des
  patients attendre à bord devant le lieu de soins et des tournées de plus de 6 h sans pause.

  La première solution OR-Tools n'aurait pas le temps de finir : elle n'est plus lancée et le planning
  est le départ Python, sans recherche locale (elle ne gagnait que 1 % de km en 10 min à cette taille). Les lieux de pause
  font deux tiers des nœuds : sans eux, le modèle de 300 voyages se construit en 1,4 s avec
  0,35 Go. Moins de lieux candidats par véhicule (`MAX_BREAK_SITES`) a été mesuré et écarté :
  perte de courses à 30 et 60 véhicules, aucun gain net à 120 ; à 2 lieux, la première solution
  finit à temps, mais les tournées sont plus longues de 5 %. Mesures :
  « Test de charge » dans [`docs/besoin-et-solution.md`](../../docs/besoin-et-solution.md). Reproduire :
  `python -m tests.bench_fleet --vehicles 120 --trips 300 --budget 38` ; vérifié par
  `test_large_fleet_gets_a_full_plan_within_the_web_timeout` (`OPTIMIZER_SLOW_TESTS=1`).
