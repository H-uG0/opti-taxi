# Taxi & Ambulance V — Optimisation des courses : besoin et solution

Nov 2, 2026 · @Hugo Dessaud — mis à jour le 7 nov. 2026 (appel avec le PO du 6 nov., test de charge)

## Contexte

V transporte surtout des patients réguliers (chimiothérapie, dialyse, radiothérapie) sur l'axe Marseille – Grenoble, via Aix, Manosque, Sisteron et Gap. Une même journée peut traverser quatre départements (13, 04, 05, 38), ce qui pèse sur les temps de trajet et sur les tarifs.

**Taille de V (appel avec le PO, 6 novembre 2026).** Environ 120 véhicules répartis entre plusieurs dépôts (différentes villes), environ 2 courses par véhicule et par jour, soit environ 300 voyages par jour. Un voyage est un aller simple : un aller-retour compte pour deux. Chiffres à confirmer : 120 × 2 donne 240, pas 300, et si une « course » est un aller-retour, on arrive à 480 voyages.

V facture trois types de courses, à des prix différents :

| Type de course (vocabulaire de V) | Équivalent réglementaire probable | Position du patient | Qui paie | Partage possible |
| --- | --- | --- | --- | --- |
| Taxi | Taxi conventionné (ou taxi classique pour un client privé) | Assis | CPAM sur prescription, ou le client | Oui, 2 patients max (règle de V) |
| Ambulance | VSL (véhicule sanitaire léger) | Assis | CPAM sur prescription | Oui, 2 patients max (règle de V) |
| Ambulance couché | Ambulance | Allongé | CPAM sur prescription | Non, 1 patient |

La correspondance « ambulance = VSL » est une hypothèse à confirmer avec V (voir Questions à poser).

Le point favorable, c'est la patientèle régulière : une personne dialysée a souvent trois séances par semaine aux mêmes horaires. L'essentiel du planning est donc connu plusieurs jours à l'avance.

## Le besoin

V veut réaliser plus de courses facturées par jour avec les mêmes véhicules et les mêmes chauffeurs. Concrètement : construire chaque jour des tournées qui enchaînent les courses avec le moins de kilomètres à vide possible, et qui regroupent deux patients compatibles dans un même véhicule.

**Le problème aujourd'hui (à confirmer).** Le planning est sans doute construit à la main par un régulateur ou le gérant. Sur un axe aussi long, chaque erreur coûte cher : un retour à vide Grenoble → Sisteron, un regroupement raté, un véhicule immobilisé devant un centre de dialyse.

**Ce qui pousse en plus à optimiser.** Depuis mars 2025, le transport partagé est la règle par défaut en taxi conventionné et en VSL, et un patient qui le refuse perd la dispense d'avance de frais ([décret 2025-202](https://www.fhf.fr/sites/default/files/2025-03/joe_20250301_0052_0015_0.pdf)). Proposer le bon regroupement devient une obligation pratique, pas seulement un gain.

**Objectifs mesurables.** Les valeurs de départ sont à mesurer sur l'historique de V avant tout développement.

| Indicateur | Pourquoi il compte |
| --- | --- |
| Courses facturées par véhicule et par jour | L'objectif annoncé par V |
| Part des kilomètres à vide | Le principal gisement sur un axe long |
| Taux de courses en transport partagé | Gain direct + attente de la CPAM |
| Patients arrivés après l'heure du rendez-vous | L'optimisation ne doit pas dégrader le service |
| Temps passé à construire le planning | Gain pour le régulateur |

**Utilisateurs.**

- Le régulateur (ou le gérant) : construit et ajuste le planning.
- Les chauffeurs : consultent leur feuille de route du jour sur téléphone.
- Plus tard, éventuellement, les patients : confirmation de l'heure de passage.

## Règles métier et contraintes

L'optimiseur doit respecter des règles réglementaires strictes : un planning « optimal » qui viole le détour maximal ou l'attente de 45 minutes n'est pas facturable comme transport partagé.

| Règle | Ce que l'application doit en faire | Source |
| --- | --- | --- |
| Le mode prescrit fixe le véhicule : allongé → ambulance ; assis → VSL ou taxi conventionné | Compatibilité stricte course ↔ type de véhicule | Prescription médicale de transport |
| Ambulance : 1 patient, équipage de 2 | Pas de partage ; planifier deux personnes par ambulance | À confirmer avec V |
| Partage : 2 patients max chez V, alors que les textes VSL prévoient jusqu'à 3 | Capacité paramétrable par véhicule, 2 par défaut | [Avenant 11, transporteurs sanitaires](https://circulaires.ameli.fr/sites/default/files/directives/CIR-TMP-Annexe%201%20-%20Avenant11_TS.pdf) |
| Partage proposé seulement si la prescription indique un état compatible, à l'aller, au retour ou les deux | Champ « partage autorisé » sur la prescription | [Décret 2025-202, art. R. 322-11-2](https://www.fhf.fr/sites/default/files/2025-03/joe_20250301_0052_0015_0.pdf) |
| Détour ≤ 10 km par patient à partir du 2e, 30 km au maximum | Contrainte dure de l'optimiseur | [Décret 2025-202, art. R. 322-11-5](https://www.fhf.fr/sites/default/files/2025-03/joe_20250301_0052_0015_0.pdf) |
| Attente au lieu de soins ≤ 45 min au total (avant le RDV + après la séance) | Contrainte dure sur les fenêtres horaires | [Décret 2025-202, art. R. 322-11-6](https://www.fhf.fr/sites/default/files/2025-03/joe_20250301_0052_0015_0.pdf) |
| Refus du patient mentionné sur la facture ; il avance alors les frais | Tracer proposition et refus par course | [Décret 2025-202, art. R. 322-11-4](https://www.fhf.fr/sites/default/files/2025-03/joe_20250301_0052_0015_0.pdf) |
| Le transporteur prévient l'accueil du lieu de soins d'un transport partagé | Liste des arrivées partagées par établissement | [Décret 2025-202, art. R. 322-11-7](https://www.fhf.fr/sites/default/files/2025-03/joe_20250301_0052_0015_0.pdf) |
| Taxi conventionné : forfait de prise en charge de 13 € + tarif kilométrique départemental, une facture par patient transporté, facturation en ligne | Estimer le chiffre d'affaires de chaque tournée, patient par patient | [Convention-cadre taxis 2025](https://www.weblex.fr/weblex-actualite/taxis-nouvelle-convention-cadre-avec-l-assurance-maladie), [Maire-info](https://www.maire-info.com/transport-sanitaire-des-milliers-de-taxis-manifestent-en-france-article2-29718) |
| Transport partagé facturé avec un abattement : 15 à 35 % de moins par trajet selon le nombre de patients | Le partage réduit le prix par patient : l'optimiseur doit raisonner en marge, pas en nombre de courses | [Amendement AN 2098](https://www.assemblee-nationale.fr/dyn/16/amendements/1682/AN/2098.pdf) |
| Horaires : arrivée avant le RDV ; fin de séance variable pour le retour | Fenêtres horaires + réoptimisation en journée | — |
| Chauffeurs : horaires, pauses, qualifications | Contraintes de ressources | À recueillir auprès de V |

Les montants changent souvent (convention taxis 2025, avenants VSL) et varient selon le département. Les tarifs doivent donc être des données modifiables dans l'application, jamais des constantes dans le code.

## Faisabilité

Oui, c'est réalisable. C'est un problème d'optimisation connu (le « Dial-a-Ride Problem » : tournées avec prises en charge, déposes et fenêtres horaires), déjà résolu en production dans le transport sanitaire. Le vrai risque n'est pas l'algorithme : c'est l'adoption par le régulateur et la place face au logiciel que V utilise déjà.

**Preuve que ça marche.** Un éditeur de solveur décrit un outil utilisé chaque jour par un grand transporteur sanitaire français : planification du transport assis la veille pour le lendemain, environ 500 missions et 50 véhicules par secteur, une solution en 5 minutes de calcul ([Hexaly](https://www.hexaly.com/wp-content/uploads/2024/02/Operational-planning-of-medical-vehicle-routes.pdf)). Avec environ 120 véhicules, V a plus de véhicules qu'un secteur de ce cas, pour moins de missions : voir « Test de charge » pour ce que cela change.

**Ce qui est simple.**

- Les courses régulières : le planning de la semaine se génère à partir des récurrences.
- La planification de la veille pour le lendemain, l'essentiel de la valeur.
- Les écrans de gestion (patients, véhicules, courses) et la carte.

**Ce qui est difficile.**

| Difficulté | Réponse proposée |
| --- | --- |
| Temps de trajet fiables en montagne et dans le trafic marseillais | OSRM auto-hébergé (gratuit, sans trafic) ralenti par des facteurs par zone et par créneau, calibrés sur les temps réels de V ; API avec trafic (Google, HERE, PTV) si l'écart avec la réalité reste trop fort |
| Heures de retour incertaines (fin de séance variable) | Réoptimisation en journée en version 2 ; durées de séance apprises sur l'historique |
| Le régulateur doit garder la main | L'outil propose, le régulateur valide ; il peut figer une course et réoptimiser le reste |
| Facturation CPAM, télétransmission, kilomètres certifiés | Hors périmètre : rester sur le logiciel métier existant, prévoir un export |
| Données de santé (un trajet vers un centre de dialyse révèle une pathologie) | Hébergeur certifié HDS en production, conformité RGPD, données fictives en développement |

**Le marché est déjà équipé.** SCR'AMBGES, un ERP pour ambulanciers, dit optimiser les tournées de plus de 1 000 entreprises, repérer les transports partagés possibles et calculer les détours ([PTV](https://www.ptvlogistics.com/en-us/resources/news/products/scr-informatiques-certifies-medical-transport-using-ptv-developer)). Des offres de régulateur citent aussi [LOMACO](https://candidat.francetravail.fr/offres/recherche/detail/191MWYJ) ou [SAPHIR](https://candidat.francetravail.fr/offres/recherche/detail/211ZHGB).

**Recommandation.** Construire un module d'optimisation de planning qui s'ajoute au logiciel actuel de V, plutôt qu'un ERP complet. Avant d'écrire une ligne de code, savoir quel logiciel V utilise et ce qui lui manque : si c'est déjà SCR'AMBGES, la valeur ajoutée est à démontrer.

## Solution proposée

Un outil web à deux faces : un écran de planification pour le régulateur, une feuille de route mobile pour les chauffeurs. Son cœur est un bouton « Optimiser demain » qui propose les tournées de chaque véhicule, que le régulateur ajuste puis valide.

**MVP (version 1).**

1. Référentiel : patients (adresse, mobilité, partage autorisé ou non), établissements de soins, véhicules (type, capacité, dépôt), chauffeurs (qualifications, horaires).
2. Courses et récurrences : saisir une fois « dialyse lundi, mercredi, vendredi, RDV 7 h 30 », puis générer automatiquement les courses de la semaine.
3. Optimisation J+1 : tournées par véhicule, regroupements proposés, et pour chaque tournée les kilomètres, les kilomètres à vide et le chiffre d'affaires estimé.
4. Ajustement manuel : déplacer une course d'un véhicule à l'autre, la figer, relancer l'optimisation sur le reste.
5. Feuille de route chauffeur (application web mobile) : ordre des arrêts, adresses, lien vers le GPS, statut « pris en charge / déposé ».
6. Traçabilité du partage : proposition faite, acceptée ou refusée, par patient et par course.
7. Tableau de bord : les cinq indicateurs du besoin, jour par jour.

**Version 2.**

- Réoptimisation en journée (course urgente, retard, séance qui finit plus tôt).
- Suivi GPS des véhicules, SMS de confirmation aux patients.
- Alertes sur les prescriptions qui arrivent à expiration.
- Durées de séance et temps de trajet appris sur l'historique.
- Export vers le logiciel de facturation de V.

**Hors périmètre.** Facturation CPAM et télétransmission, prise d'appels, transports d'urgence (exclus du transport partagé par le décret).

## Besoins ajoutés par le PO (6 novembre 2026)

L'appel élargit le produit : au-delà des tournées, V veut planifier son personnel et sa flotte. Lecture des notes prises pendant l'appel, à valider avec le PO :

| Note | Lecture | Existant dans l'application | À confirmer |
| --- | --- | --- | --- |
| Planning chauffeur, congés, week-ends, gardes | Savoir qui travaille à une date donnée, pas seulement selon une semaine type | Jours et horaires fixes par chauffeur, sans exception datée | Une garde bloque-t-elle un équipage et un véhicule ? |
| Personnel : ambulanciers par paires, accompagnants | Former les équipages du jour selon l'entente entre employés (paires possibles ou non) | Équipier possible sur le véhicule et la tournée, sans notion d'entente | « Accompagnant » = employé, ou proche du patient qui prend une place ? |
| Planning voitures : consommation, révision, entretien | Bloquer un véhicule en entretien, suivre ses échéances et sa consommation | Véhicule actif ou non, coût au km unique | Saisie dans l'outil ou import depuis un logiciel existant ? |
| Préférence du client pour un type de véhicule ou un chauffeur | Préférence prise en compte sans jamais passer outre la prescription | Rien | Préférence ou exigence ? |
| Gestion d'affinités | Entre collègues d'après les notes ; peut-être aussi patient–chauffeur et patient–patient en partage | Rien | Lesquelles retenir ? |
| Cotation du prix du véhicule pour le trajet (Sisteron – Grenoble en diesel, Sisteron – Aix en électrique) | Choisir le véhicule le plus rentable pour le trajet : énergie, consommation, autonomie | Coût au km par véhicule, sans énergie ni autonomie | Coût interne ou devis au client ? Autonomie ou coût ? Où recharger ? |
| Dépôts dans différentes villes | Dépôt = lieu de rattachement des véhicules et du personnel | Chaque véhicule a déjà son dépôt, saisi en texte et coordonnées | Un véhicule peut-il finir sa journée dans un autre dépôt ? |
| Partage de clients, sous-traitance (entre parenthèses dans les notes) | Confier à un partenaire les courses non couvertes, ou en recevoir | Rien | Dans quel sens ? Pour plus tard ? Transmettre des données de santé à un tiers demande un cadre RGPD |

**Ce que cela change au positionnement.** La recommandation était un module ajouté au logiciel de V, pas un ERP. Plannings du personnel et suivi de flotte s'en rapprochent : si le logiciel actuel de V les gère, mieux vaut les importer que les refaire. La question du logiciel actuel reste la première à poser.

**Plan proposé, un lot à la fois, chacun validé avant le suivant :**

1. Cadrage et test de charge à l'échelle annoncée (fait le 7 novembre, voir « Test de charge »).
2. Dépôts : entité à part, véhicules et personnel rattachés.
3. Planning du personnel : congés, week-ends, gardes par date, équipages du jour avec paires interdites.
4. Planning des véhicules : indisponibilités, échéances d'entretien avec alertes, consommation ; l'optimiseur ignore un véhicule indisponible.
5. Coût et autonomie par véhicule (énergie, consommation) : le choix diesel / électrique découle de la marge, plus une contrainte d'autonomie revérifiée par le validateur.
6. Préférences et affinités patient : bonus ou pénalités dans l'objectif ; seules les exigences explicites deviennent des contraintes dures.
7. Sous-traitance, plus tard.

**Choix structurant à valider.** Aujourd'hui le chauffeur vient du véhicule (chauffeur attitré). Proposition : fixer d'abord les équipages du jour (proposés automatiquement, ajustés par le régulateur), puis calculer les tournées avec ces équipages. C'est plus simple et plus lisible qu'un calcul simultané, et cela devrait mieux tenir à 120 véhicules. En contrepartie, la solution peut être un peu moins optimale, et une préférence pour un chauffeur reste limitée par les équipages déjà fixés.

## Moteur d'optimisation

Chaque soir, le moteur affecte chaque course à un véhicule et ordonne les arrêts pour maximiser la marge de la journée, sans violer aucune règle. En recherche opérationnelle, c'est un problème de tournées avec prises en charge, déposes et fenêtres horaires (PDPTW, ou Dial-a-Ride).

**Formulation.**

- Une course = une paire prise en charge → dépose, avec une fenêtre horaire (arriver avant le RDV, repartir après la séance).
- Un véhicule part de son dépôt et y revient, avec un type (taxi, VSL, ambulance), une capacité (1 ou 2) et un chauffeur aux horaires connus.
- Contraintes dures : type compatible, capacité, fenêtres horaires, détour ≤ 10 km pour un patient partagé, attente ≤ 45 min au lieu de soins, patients non partageables seuls à bord, horaires et pauses des chauffeurs.
- Attente de 45 min : en V1, découper ce budget en deux paramètres réglables (une marge avant le RDV, une après la séance), dont la somme ne dépasse pas 45 min.

**Objectif.** Maximiser la marge estimée, avec une forte pénalité par course non affectée pour que le régulateur la voie tout de suite. Le cas Hexaly vise plutôt le chiffre d'affaires par heure travaillée, une variante à tester.

```latex
\max \; \sum_{c \,\in\, \text{courses servies}} \text{CA}_c \;-\; \sum_{v \,\in\, \text{véhicules}} \left( \text{km}_v \cdot c_{\text{km}} + \text{heures}_v \cdot c_{\text{h}} \right) \;-\; P \cdot N_{\text{non affectées}}
```

Raisonner en marge plutôt qu'en nombre de courses compte ici : un partage baisse le prix par patient (abattement) mais économise des kilomètres et du temps chauffeur. C'est aussi ce qui fera choisir taxi ou VSL selon la distance.

**Outils.**

| Brique | Choix proposé | Pourquoi |
| --- | --- | --- |
| Solveur | Google OR-Tools (Python), routage avec paires prise en charge / dépose | Gratuit ; gère fenêtres horaires, capacités, véhicules autorisés par course ; le détour maximal s'exprime avec une dimension de distance |
| Alternative pour prototyper vite | VROOM | Moteur open source appelé en HTTP, simple à brancher depuis Node, mais moins souple pour les contraintes de détour |
| Distances et temps de trajet | OSRM auto-hébergé, extraits OpenStreetMap PACA + Auvergne-Rhône-Alpes | Gratuit ; matrice de temps calculée localement |
| Taille du problème | Environ 120 véhicules et 300 voyages par jour (PO, 6 novembre 2026) | Le cas Hexaly traite 500 missions en 5 minutes ; chez V, c'est le nombre de véhicules qui pèse (voir « Test de charge ») |

## Test de charge (7 novembre 2026)

Le service d'optimisation a été lancé sur une journée fictive à l'échelle annoncée par le PO : 120 véhicules répartis sur 6 dépôts (Marseille, Aix, Manosque, Sisteron, Gap, Grenoble), 50 % de taxis, 35 % de VSL, 15 % d'ambulances, pause du midi pour 7 chauffeurs sur 8 ; 150 patients en aller-retour, dont la moitié soignés hors de leur ville (Sisteron – Grenoble, Sisteron – Aix, Gap – Marseille…), et les réglages de trafic par défaut du web. Distances à vol d'oiseau, machine de développement, 1,5 cœur par calcul. Générateur : `fleet_day()` dans `services/optimizer/tests/builders.py` ; banc : `services/optimizer/tests/bench_fleet.py`.

**Résultat : à cette taille, « Optimiser demain » renvoie un planning vide.** Le web accorde au solveur 1 s par tranche de 8 courses (38 s pour 300 voyages). Ce budget ne suffit pas à la première étape du solveur, la construction initiale d'OR-Tools, qui est coupée sans avoir placé une seule course. Le planning vide ne viole aucune contrainte : il est déclaré valide, puis enregistré à la place des tournées déjà proposées pour la journée.

| Scénario | Construction du modèle | Construction initiale OR-Tools | Courses placées au budget du web | Mémoire |
| --- | --- | --- | --- | --- |
| 120 véhicules, 300 voyages (budget 38 s) | 13 s | 57 s (coupée à 47 s) | 0 sur 297 atteignables, réponse en 60 s | 1,9 Go |
| 120 véhicules, 480 voyages (budget 60 s) | 28 s | coupée à 73 s sans avoir fini | 0 sur 476, réponse en 102 s | 4,0 Go |
| 120 véhicules, 300 voyages, sans pause | 1,4 s | non mesurée | non mesuré | 0,35 Go |

**Le problème n'est pas trop gros : c'est l'ordre des étapes du solveur.** La seconde construction, écrite en Python (insertion par regret), place toutes les courses atteignables en quelques secondes, avec un planning valide : 297 sur 297 en 3,3 s pour 300 voyages, 474 sur 476 en 7,4 s pour 480 voyages. Résultat identique sur un autre tirage du jeu fictif (294 sur 294) et avec 20 % de longs trajets au lieu de 50 % (297 sur 297). Quand la construction d'OR-Tools a le temps de finir, c'est d'ailleurs ce planning Python qui est retenu, car meilleur. Il manque seulement de le construire en premier.

| Budget accordé au solveur (300 voyages) | Courses placées | Véhicules utilisés | Km | Réponse |
| --- | --- | --- | --- | --- |
| 38 s (budget actuel du web) | 0 | 0 | 0 | 60 s |
| Insertion Python seule (mesure hors service) | 297 | 74 | 16 675 | 17 s (dont 13 s de construction du modèle) |
| Insertion Python puis 38 s de recherche locale (mesure hors service) | 297 | 74 | 16 706 | 57 s |
| 120 s | 297 | 74 | 16 706 | 134 s |
| 300 s | 297 | 75 | 16 667 | 318 s |
| 600 s | 297 | 77 | 16 540 | 614 s |

La recherche locale apporte peu à cette taille (moins de 1 % de km en moins après 10 minutes). Les 3 courses non placées ont des horaires inatteignables par construction du jeu fictif.

**Ce qui pèse : les lieux de pause.** Chaque chauffeur dispose de jusqu'à 24 lieux de pause candidats (dépôt, établissements, domiciles). À 120 véhicules, ils font 64 % des nœuds du modèle (1 286 sur 2 000) ; sans eux, la construction du modèle passe de 13 s à 1,4 s et la mémoire de 1,9 Go à 0,35 Go.

**Correctifs :**

1. Fait (7 novembre) — solveur : le planning Python est construit en premier et confirmé aussitôt par OR-Tools ; la construction d'OR-Tools vient ensuite et ne le remplace que par un planning moins coûteux. On ne renvoie plus jamais un planning plus pauvre que le planning Python.
2. À décider — solveur : limiter les lieux de pause candidats par véhicule quand la flotte est grande. Cela rendrait du temps à la construction d'OR-Tools et à la recherche locale ; l'effet sur la qualité des tournées reste à mesurer.
3. Fait (7 novembre) — web : un planning qui ne sert aucune course alors que des courses étaient envoyées n'est plus enregistré. L'optimisation échoue avec le motif le plus fréquent, et le planning en place est conservé.
4. Fait (7 novembre), côté optimiseur — la construction du modèle est comptée dans le budget, que la marge du web (budget plus 30 s) n'avait pas à absorber en plus.

**Après les correctifs 1 et 4,** au budget envoyé par le web : 297 voyages placés sur 297 en 49 s pour 300 voyages (le web attend jusqu'à 68 s), 474 sur 476 en 74 s pour 480 voyages (jusqu'à 90 s). La construction d'OR-Tools n'a toujours pas le temps de finir à cette taille : le planning est celui de l'insertion Python, sans recherche locale, ce qui coûte environ 1 % de kilomètres d'après les mesures ci-dessus. Sur les journées plus petites (60 à 300 courses, 10 à 60 véhicules), avant et après donnent le même nombre de courses servies (une de plus sur l'une d'elles) et les mêmes kilomètres à 0,1 % près.

**Une piste métier, à vérifier sur l'historique réel.** Sur ce jeu fictif, environ 300 voyages tiennent sur 61 à 77 véhicules (4 à 5 voyages par véhicule utilisé), contre environ 2,5 annoncés par véhicule chez V. L'écart vient peut-être des hypothèses du jeu : distances à vol d'oiseau, aucun véhicule ni chauffeur indisponible, rendez-vous répartis sur la journée, trajets plus courts que les vrais. C'est précisément ce que l'historique de V permettra de trancher (Feuille de route, phase 1). Les montants de marge du jeu fictif ne disent rien : les coûts y sont inventés.

## Modèle de données

Neuf entités suffisent pour le MVP ; la course est le pivot, la tournée est ce que produit l'optimiseur.

| Entité | Champs clés | Relations |
| --- | --- | --- |
| Patient | nom, adresse géocodée, téléphone, mobilité (assis, fauteuil, allongé), notes d'accès | a des prescriptions, des récurrences, des courses |
| Établissement | nom, adresse géocodée, type (CHU, centre de dialyse, radiothérapie…) | destination des courses |
| Prescription | mode prescrit (taxi/VSL, ambulance), partage autorisé (aller, retour, les deux, non), début et fin de validité, série oui/non | appartient à un patient |
| Récurrence | jours, heure de RDV, durée de séance estimée, aller et/ou retour | patient → établissement ; génère des courses |
| Course | date, origine, destination, fenêtre horaire, type de véhicule requis, statut, partage proposé / accepté / refusé, verrou manuel | liée à une prescription ; placée dans une tournée |
| Véhicule | immatriculation, type, capacité, dépôt, coût kilométrique | affecté à des tournées |
| Chauffeur | qualifications (taxi, auxiliaire, ambulancier DE), horaires, pauses | affecté à des tournées |
| Tournée | date, véhicule, chauffeur, arrêts ordonnés avec heures prévues, km, km à vide, CA estimé, statut (proposée, validée) | regroupe des courses |
| Grille tarifaire | type de transport, département, forfait, prix au km, abattement de partage, dates de validité | sert au calcul du CA estimé |

## Architecture et stack technique

Une application Next.js en TypeScript porte les écrans et l'API ; seul le calcul des tournées part dans un petit service Python, car OR-Tools n'a pas de version JavaScript officielle.

&#91;embedded content: architecture · 6 briques, hébergement HDS\]

Le régulateur et les chauffeurs passent par la même application ; l'export vers le logiciel de facturation (en pointillé) vient après le MVP.

| Brique | Technologie | Remarque |
| --- | --- | --- |
| Interface régulateur et chauffeurs | Next.js (App Router), TypeScript, Tailwind, MapLibre GL | Application web mobile pour les chauffeurs : pas de store à gérer |
| Base de données | PostgreSQL + Prisma (SQL Server possible) | PostGIS utile plus tard pour les requêtes géographiques |
| Optimisation | Python, FastAPI, Google OR-Tools | Contrat JSON typé : zod côté TypeScript, pydantic côté Python |
| Temps de trajet | OSRM en Docker, facteurs de trafic par zone et créneau | Remplaçable par une API avec trafic si besoin (`TrafficProvider`) |
| Hébergement | Hébergeur certifié HDS | Obligatoire dès qu'il y a de vraies données patients |

## Feuille de route

Le premier livrable n'est pas l'application : c'est la preuve, sur l'historique réel de V, que l'optimiseur fait mieux que le planning manuel.

&#91;embedded content: feuille de route · 5 phases, 5 feux verts\]

Chaque phase ne démarre que si le feu vert précédent est passé ; si le prototype ne bat pas le planning manuel, le projet s'arrête là, à faible coût.

## Questions à poser au client

Les trois premières décident si le projet vaut la peine ; les autres fixent les paramètres du moteur.

- [ ] Quel logiciel utilisez-vous aujourd'hui pour la régulation et la facturation, et que lui manque-t-il ?
- [ ] Qui fait le planning, comment, et combien de temps cela prend-il chaque jour ?
- [ ] Quel objectif compte le plus : plus de courses, moins de kilomètres à vide, ou moins de temps de régulation ?
- [ ] Que recouvrent vos termes : « ambulance » = VSL ? « taxi » = conventionné, privé, ou les deux ?
- [ ] Combien de véhicules par type, combien de chauffeurs, quels dépôts ? En partie répondu le 6 novembre : environ 120 véhicules, plusieurs dépôts dans différentes villes.
- [ ] Combien de courses par jour, et quelle part de patients réguliers ? En partie répondu le 6 novembre : environ 300 voyages (allers simples) par jour, à recouper avec « 2 courses par véhicule et par jour ».
- [ ] La limite de 2 patients par véhicule est-elle un choix de V ou une contrainte des véhicules ?
- [ ] Quelle tolérance d'horaire : combien de temps avant le RDV un patient accepte-t-il d'arriver ?
- [ ] Comment connaît-on l'heure de fin de séance pour organiser le retour ?
- [ ] Pouvez-vous exporter 2 à 4 semaines d'historique de courses (dates, adresses, horaires, type, prix) ?
- [ ] Les chauffeurs ont-ils un smartphone professionnel ?
- [ ] Quel budget et quel délai, et qui hébergera l'application (hébergeur HDS) ?

Ajoutées après l'appel du 6 novembre (entre parenthèses, l'hypothèse retenue en attendant) :

- [ ] Volume : 120 × 2 donne 240, pas 300 ; et si une « course » est un aller-retour, 480 voyages. Quel chiffre, et les 120 véhicules roulent-ils tous chaque jour ? (environ 300 allers simples par jour)
- [ ] « Accompagnants » : du personnel, ou des proches du patient qui prennent une place à bord ? (du personnel)
- [ ] « Cotation » : coût interne pour choisir le véhicule, ou prix annoncé au client ? (coût interne)
- [ ] Électrique : l'exemple Sisteron – Aix s'explique-t-il par l'autonomie, le coût, autre chose ? Où recharge-t-on ? (autonomie et coût, recharge au dépôt)
- [ ] Préférences et affinités : lesquelles sont impératives ? (paires de collègues interdites impératives, préférences patient souhaitables)
- [ ] Le logiciel actuel gère-t-il déjà plannings du personnel et entretien ? Si oui, les lots correspondants se réduisent à un import.

## Brief de démarrage pour Claude Code

Ce bloc est à coller tel quel dans un fichier `CLAUDE.md` à la racine du dépôt. Il reprend l'essentiel de ce document sous une forme directement exploitable.

```markdown
# Projet : optimiseur de tournées — Taxi & Ambulance V

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
- apps/web : Next.js (App Router) + TypeScript, Tailwind, MapLibre GL.
- Base : PostgreSQL + Prisma.
- services/optimizer : Python 3.12, FastAPI, Google OR-Tools (pickup and delivery with time windows).
- Contrat JSON entre web et optimizer : zod côté TypeScript, pydantic côté Python.
- OSRM en Docker (extraits OpenStreetMap PACA + Auvergne-Rhône-Alpes) pour les temps et distances.

## Données
- Jamais de vraies données patients en développement : jeu fictif généré par le seed.
- Production : hébergeur certifié HDS (données de santé).

## Glossaire
- TAP : transport assis professionnalisé (taxi conventionné ou VSL).
- VSL : véhicule sanitaire léger.
- PMT : prescription médicale de transport.
- Transport partagé : au moins 2 patients en même temps dans un véhicule TAP.
- Série : transports répétés pour un même traitement.

## Premières étapes
1. Scaffold du monorepo + docker-compose (Postgres, OSRM, optimizer).
2. Schéma Prisma des 9 entités + seed fictif (une dizaine de véhicules, une soixantaine de courses par jour).
3. Service optimizer : POST /optimize, tests sur le jeu fictif, validateur des contraintes dures.
4. Écran planning J+1 en lecture seule, puis ajustement manuel.
Avancer par petites étapes testées ; demander avant tout choix structurant.
```

## Sources

- [Décret n° 2025-202 du 28 février 2025 relatif aux transports partagés, JO du 1er mars 2025](https://www.fhf.fr/sites/default/files/2025-03/joe_20250301_0052_0015_0.pdf)
- [WebLex, nouvelle convention-cadre taxis avec l'Assurance maladie (mai 2025)](https://www.weblex.fr/weblex-actualite/taxis-nouvelle-convention-cadre-avec-l-assurance-maladie)
- [Maire-info, forfait de prise en charge des taxis conventionnés (mai 2025)](https://www.maire-info.com/transport-sanitaire-des-milliers-de-taxis-manifestent-en-france-article2-29718)
- [Ameli, avenant 11 à la convention des transporteurs sanitaires](https://circulaires.ameli.fr/sites/default/files/directives/CIR-TMP-Annexe%201%20-%20Avenant11_TS.pdf)
- [Assemblée nationale, amendement n° 2098 (coût du transport partagé)](https://www.assemblee-nationale.fr/dyn/16/amendements/1682/AN/2098.pdf)
- [Hexaly, planification opérationnelle de tournées de véhicules sanitaires](https://www.hexaly.com/wp-content/uploads/2024/02/Operational-planning-of-medical-vehicle-routes.pdf)
- [PTV Logistics, SCR Informatiques et SCR'AMBGES (sept. 2025)](https://www.ptvlogistics.com/en-us/resources/news/products/scr-informatiques-certifies-medical-transport-using-ptv-developer)
- Offres France Travail citant [LOMACO](https://candidat.francetravail.fr/offres/recherche/detail/191MWYJ) et [SAPHIR](https://candidat.francetravail.fr/offres/recherche/detail/211ZHGB)
