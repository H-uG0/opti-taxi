# Taxi & Ambulance V — Optimisation des courses : besoin et solution

Nov 2, 2026 · @Hugo Dessaud — mis à jour le 7 nov. 2026 (appel avec le PO du 6 nov., test de charge) et le 9 nov. 2026 (réglementation, concurrence, questions au client)

## Contexte

V transporte surtout des patients réguliers (chimiothérapie, dialyse, radiothérapie) sur l'axe Marseille – Grenoble, via Aix, Manosque, Sisteron et Gap. Une même journée peut traverser quatre départements (13, 04, 05, 38), ce qui pèse sur les temps de trajet et sur les tarifs.

**Taille de V (appel avec le PO, 6 novembre 2026).** Environ 120 véhicules répartis entre plusieurs dépôts (différentes villes), environ 2 courses par véhicule et par jour, soit environ 300 voyages par jour. Un voyage est un aller simple : un aller-retour compte pour deux. Chiffres à confirmer : 120 × 2 donne 240, pas 300, et si une « course » est un aller-retour, on arrive à 480 voyages.

V facture trois types de courses, à des prix différents :

| Type de course (vocabulaire de V) | Équivalent réglementaire probable | Position du patient | Qui paie | Partage possible |
| --- | --- | --- | --- | --- |
| Taxi | Taxi conventionné (ou taxi classique pour un client privé) | Assis | CPAM sur prescription, ou le client | Oui, 2 patients max (règle de V) |
| Ambulance | VSL (véhicule sanitaire léger) | Assis | CPAM sur prescription | Oui, 2 patients max (règle de V) |
| Ambulance couché | Ambulance | Allongé | CPAM sur prescription | Non, 1 patient |

La correspondance « ambulance = VSL » est une hypothèse à confirmer avec V (voir Questions à poser).

Le point favorable, c'est la patientèle régulière : une personne dialysée a souvent trois séances par semaine aux mêmes horaires. L'essentiel du planning est donc connu plusieurs jours à l'avance.

## Le besoin

V veut réaliser plus de courses facturées par jour avec les mêmes véhicules et les mêmes chauffeurs. Concrètement : construire chaque jour des tournées qui enchaînent les courses avec le moins de kilomètres à vide possible, et qui regroupent deux patients compatibles dans un même véhicule.

**Le problème aujourd'hui (à confirmer).** Le planning est sans doute construit à la main par un régulateur ou le gérant. Sur un axe aussi long, chaque erreur coûte cher : un retour à vide Grenoble → Sisteron, un regroupement raté, un véhicule immobilisé devant un centre de dialyse.

**Ce qui pousse en plus à optimiser.** Depuis le 2 mars 2025, le transport partagé doit être proposé en taxi conventionné et en VSL pour cinq catégories de soins, dont la dialyse, la chimiothérapie et la radiothérapie, si la prescription ne l'exclut pas. Un patient qui le refuse perd la dispense d'avance de frais ([décret 2025-202](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006073189/LEGISCTA000006173384/), voir « Réglementation 2025-2027 »). Proposer le bon regroupement devient une obligation pratique, pas seulement un gain. Au 1er janvier 2027 au plus tard, chaque véhicule devra aussi avoir une géolocalisation certifiée et une facturation électronique intégrée : V aura donc un logiciel certifié, auquel Opti-Taxi devra se brancher.

**Objectifs mesurables.** Les valeurs de départ sont à mesurer sur l'historique de V avant tout développement.

| Indicateur | Pourquoi il compte |
| --- | --- |
| Courses facturées par véhicule et par jour | L'objectif annoncé par V |
| Part des kilomètres à vide | Le principal gisement sur un axe long |
| Taux de courses en transport partagé | Gain direct + attente de la CPAM |
| Patients arrivés après l'heure du rendez-vous | L'optimisation ne doit pas dégrader le service |
| Temps passé à construire le planning | Gain pour le régulateur |

**Utilisateurs.**

- Le régulateur (ou le gérant) : construit et ajuste le planning.
- Les chauffeurs : consultent leur feuille de route du jour sur téléphone.
- Plus tard, éventuellement, les patients : confirmation de l'heure de passage.

## Règles métier et contraintes

L'optimiseur doit respecter des règles réglementaires strictes : un planning « optimal » qui viole le détour maximal ou l'attente de 45 minutes n'est pas facturable comme transport partagé.

| Règle | Ce que l'application doit en faire | Source |
| --- | --- | --- |
| Le mode prescrit fixe le véhicule : allongé → ambulance ; assis → VSL ou taxi conventionné | Compatibilité stricte course ↔ type de véhicule | Prescription médicale de transport |
| Ambulance : 1 patient, équipage de 2 | Pas de partage ; planifier deux personnes par ambulance | À confirmer avec V |
| Partage : 2 patients max chez V, alors que les textes VSL prévoient jusqu'à 3 | Capacité paramétrable par véhicule, 2 par défaut | [Avenant 11, transporteurs sanitaires](https://circulaires.ameli.fr/sites/default/files/directives/CIR-TMP-Annexe%201%20-%20Avenant11_TS.pdf), [ameli, tarifs VSL](https://www.ameli.fr/transporteur-sanitaire/exercice-professionnel/facturation/tarifs/vsl-tarifs-conventionnels) |
| Partage proposé seulement en TAP (VSL, taxi), si la prescription indique un état compatible, à l'aller, au retour ou les deux | Champ « partage autorisé » sur la prescription | [Décret 2025-202, art. R. 322-11-1 à R. 322-11-8](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006073189/LEGISCTA000006173384/) |
| Partage à proposer pour cinq catégories de soins : traitements médicamenteux systémiques du cancer, radiothérapie, dialyse, soins médicaux de réadaptation, hospitalisation de jour | Pas encore dans l'application : le partage ne dépend que de la prescription (catégorie de soins à saisir) | Arrêté du 28 février 2025 ([FHF](https://www.fhf.fr/expertises/finances/budget-eprd/conditions-de-mise-en-oeuvre-des-transports-partages-de-patients-0), [Service-Public](https://www.service-public.gouv.fr/particuliers/actualites/A18110)) |
| Détour ≤ 10 km par patient à partir du 2e, 30 km au maximum | Contrainte dure de l'optimiseur | [Décret 2025-202, art. R. 322-11-5](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006073189/LEGISCTA000006173384/) |
| Attente au lieu de soins ≤ 45 min au total (avant le RDV + après la séance) | Contrainte dure sur les fenêtres horaires | [Décret 2025-202, art. R. 322-11-6](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006073189/LEGISCTA000006173384/) |
| Refus du patient mentionné sur la facture ; il perd alors la dispense d'avance de frais | Tracer proposition et refus par course | [Décret 2025-202, art. R. 322-11-4](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006073189/LEGISCTA000006173384/) |
| Le transporteur prévient l'accueil du lieu de soins d'un transport partagé | Liste des arrivées partagées par établissement | [Décret 2025-202, art. R. 322-11-7](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006073189/LEGISCTA000006173384/) |
| Taxi conventionné (tarifs du 1er novembre 2025) : forfait de 13 € qui inclut les 4 premiers km en charge, tarif kilométrique selon le département de l'ADS, majorations, une facture par patient sur la distance qu'il a parcourue | Estimer le chiffre d'affaires de chaque tournée, patient par patient ; détail dans « Réglementation 2025-2027 » | [Arrêté du 29 juillet 2025 (convention-cadre)](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052060568), [ameli](https://www.ameli.fr/taxi-conventionne/textes-reference/convention-nationale-type) |
| Transport partagé facturé avec un abattement par patient. Taxi : 23 % à 2 patients, 35 % à 3, 37 % à 4 et plus. VSL : 15 % à 2 patients et 33 % à 3 si l'entreprise facture par SEFi avec une flotte géolocalisée certifiée, sinon 23 % et 35 % | Le partage réduit le prix par patient : l'optimiseur doit raisonner en marge, pas en nombre de courses | [Arrêté du 29 juillet 2025](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052060568), [ameli, tarifs VSL](https://www.ameli.fr/transporteur-sanitaire/exercice-professionnel/facturation/tarifs/vsl-tarifs-conventionnels) |
| Ambulance utilisée exceptionnellement pour un transport assis, faute de taxi ou de VSL, facturée au tarif VSL | Proposée par le régulateur pour une course assise non affectée, jamais par l'optimiseur seul ; motif tracé sur la course et compté au tableau de bord | [Protocole du 24 septembre 2025, art. 4.1.1](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052304334) |
| Horaires : arrivée avant le RDV ; fin de séance variable pour le retour | Fenêtres horaires + réoptimisation en journée | — |
| Chauffeurs : horaires, pauses, qualifications | Contraintes de ressources | À recueillir auprès de V |

Les montants changent souvent (convention taxis 2025, avenants VSL) et varient selon le département. Les tarifs doivent donc être des données modifiables dans l'application, jamais des constantes dans le code.

Correction du 9 novembre 2026 : la version précédente annonçait un abattement de partage de « 15 à 35 % », tiré d'un amendement parlementaire (AN n° 2098). C'était faux pour le taxi : 15 % et 33 % sont les abattements du VSL certifié. Les taux en vigueur sont ceux du tableau ci-dessus.

## Réglementation 2025-2027 (vérifiée le 9 novembre 2026)

Vérifiée sur les sources officielles (Légifrance, Service-Public, ameli, Assemblée nationale, Cour des comptes), avec la presse spécialisée en complément. Chaque texte porte un niveau de vérification :

- **Confirmé** : texte officiel lu.
- **Partiel** : texte officiel lu, mais un point reste à recouper ; il est signalé.
- **À confirmer** : texte connu par des sources indirectes (questions écrites, blog d'avocat, mémo de veille sans lien conservé), pas lu sur Légifrance.
- **Non confirmé** : aucun texte trouvé.
- **Non revérifié** : relevé par l'étude de départ ou par l'audit réglementaire du projet, avec une source officielle, mais pas recontrôlé le 9 novembre.

Les montants cités servent à comprendre les règles. Ils sont à recontrôler avant toute saisie dans les grilles tarifaires.

| Texte | Ce qu'il change | Date | Niveau |
| --- | --- | --- | --- |
| Loi n° 2026-534 du 25 juin 2026, art. 27 | Géolocalisation certifiée et facturation électronique intégrée dans tous les véhicules | Au plus tard le 1er janvier 2027 | Confirmé |
| Décret n° 2025-202 et arrêté du 28 février 2025 | Transport partagé à proposer en TAP, pour cinq catégories de soins | 2 mars 2025 | Partiel (règles du partage : confirmé) |
| Convention-cadre des taxis conventionnés (arrêté du 29 juillet 2025) | Tarifs, abattements de partage, obligations de facturation | Tarifs du 1er novembre 2025 | Partiel |
| Même convention, art. 5.2 et 7.1 | Patients du territoire de l'ADS en majorité ; sous-traitance à une entreprise conventionnée seulement | 1er novembre 2026 (art. 5.2, selon une question écrite) | Non revérifié |
| Protocole des transporteurs sanitaires du 24 septembre 2025 | Tarifs VSL et ambulance selon la certification, objectif de partage | 1er octobre 2025, puis 1er juillet 2027 | Partiel |
| SEFi et prescription électronique (e-PMT) | SEFi obligatoire pour les transporteurs sanitaires (depuis 2021, sans sanction) et pour les taxis ; aucune obligation e-PMT trouvée | 1er janvier 2027 pour les taxis | SEFi : partiel ; e-PMT : à confirmer (source non conservée) |
| Décret n° 2026-812 du 21 août 2026 | Une ALD non exonérante ne justifie plus seule un transport | 1er octobre 2026 | À confirmer |
| Accord préalable (DAP) | Obligatoire au-delà de 150 km et pour certaines séries longues | En vigueur | Non revérifié |
| Art. R. 322-10-5 du code de la sécurité sociale | Remboursement plafonné à la structure de soins appropriée la plus proche | En vigueur | Non revérifié |
| Avenant 12 des transporteurs sanitaires | — | — | Non confirmé (dernier trouvé : avenant 11) |
| Décret n° 2026-787, LFSS 2026, loi 2026-534 art. 78 et 97 | Voir « Autres textes à anticiper » | 2027-2028 | À confirmer (source non conservée) |

### Géolocalisation certifiée et facturation intégrée (loi 2026-534, art. 27) — confirmé

- Les entreprises de transport sanitaire et de taxi conventionnées équipent tous leurs véhicules d'un dispositif de géolocalisation certifié par l'Assurance maladie et d'un système électronique de facturation intégré (art. L. 322-5-3 du code de la sécurité sociale).
- Un décret fixe la date, au plus tard le 1er janvier 2027. Un décret en Conseil d'État fixe les conditions. Aucun décret d'application trouvé au 9 novembre 2026.
- Taxis : la convention-cadre de 2025 l'imposait déjà au 1er janvier 2027, sous peine de déconventionnement.
- Transporteurs sanitaires : c'est nouveau. Jusqu'ici, l'avenant 11 l'encourageait par le tarif.
- Pour Opti-Taxi : V aura de toute façon un logiciel certifié. Opti-Taxi ne le remplace pas, il s'y branche.
- Sources : [art. L. 322-5-3](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006742504), [loi n° 2026-534](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000054309429), [Service-Public, 30 juin 2026](https://entreprendre.service-public.gouv.fr/actualites/A18978), [Cour des comptes, RALFSS 2026, chap. VII](https://www.ccomptes.fr/sites/default/files/2026-05/20260527-RALFSS-2026-7-Transports-patients-a-la-charge-de-l-assurance-maladie.pdf).

### Transport partagé (décret 2025-202, arrêté du 28 février 2025) — partiel ; règles du partage confirmées

- Articles R. 322-11-1 à R. 322-11-8 du code de la sécurité sociale, en vigueur depuis le 2 mars 2025.
- Le partage doit être proposé, pas imposé. Il ne concerne que le transport assis professionnalisé : VSL et taxi conventionné, jamais l'ambulance.
- Conditions : la prescription indique que l'état de santé n'est pas incompatible (case « compatible » pré-cochée sur les formulaires), et le soin entre dans une des cinq catégories de l'arrêté du 28 février 2025 : traitements médicamenteux systémiques du cancer, radiothérapie, épuration extrarénale (dialyse), soins médicaux de réadaptation, hospitalisation de jour. L'aide médicale urgente est exclue.
- Un refus fait perdre la dispense d'avance de frais. La loi prévoit aussi un coefficient de minoration, non appliqué en mai 2026.
- Règles du partage (confirmé) :
  - détour (R. 322-11-5) : au plus 10 km par patient transporté à partir du deuxième, dans la limite de 30 km (10 km à deux, 20 km à trois, 30 km à quatre ou plus) ;
  - attente (R. 322-11-6) : pour chaque patient, 45 min au plus au total sur le lieu de soins, avant l'heure du soin et après le soin ;
  - information (R. 322-11-7) : le transporteur informe l'accueil du lieu de soins ;
  - refus (R. 322-11-4) : il est mentionné sur la facture ou le justificatif (R. 322-10-2).
- À confirmer : les bénéficiaires de la C2S et de l'AME ne seraient pas concernés (circulaire CNAM CIR-5/2025, non lue).
- Dans Opti-Taxi : détour, attente, TAP seul, prescription, refus tracé et feuille des arrivées partagées sont en place. Les cinq catégories de soins ne sont pas saisies : le partage est proposé dès que la prescription l'autorise, y compris pour un soin hors de ces catégories, où un refus ne devrait pas coûter au patient la dispense d'avance de frais.
- Sources : [Légifrance, R. 322-11-1 à R. 322-11-8](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006073189/LEGISCTA000006173384/), [Service-Public](https://www.service-public.gouv.fr/particuliers/actualites/A18110), [FHF](https://www.fhf.fr/expertises/finances/budget-eprd/conditions-de-mise-en-oeuvre-des-transports-partages-de-patients-0).

### Taxis conventionnés : convention-cadre et tarifs du 1er novembre 2025 — partiel

- Nouvelle convention approuvée par l'arrêté du 29 juillet 2025 (JO du 8 août 2025). Tarifs en vigueur depuis le 1er novembre 2025.
- Forfait « prise en charge et accompagnement » : 13 €, qui inclut les 4 premiers km en charge.
- Tarif kilométrique selon le département de l'ADS, avec un plancher de 1,07 € : 04 = 1,14 € ; 05 = 1,18 € ; 13 = 1,10 € ; 26 = 1,16 € ; 38 = 1,22 € ; 84 = 1,20 €. Ces taux sont à recontrôler avant saisie.
- Forfait « Grande ville » : 15 €. La liste inclut Marseille (mise à jour ameli d'avril 2026).
- +50 % de 20 h à 8 h, le week-end et les jours fériés. Supplément TPMR : 30 €. Péages en sus.
- Retour à vide d'un transport hospitalier (entrée ou sortie, chimiothérapie, radiothérapie, hémodialyse) : tarif kilométrique +25 % si le trajet en charge fait moins de 50 km, +50 % au-delà.
- Partage : une facture par patient, sur la distance réellement parcourue par chacun. Abattements de 23 % à 2 patients, 35 % à 3 et 37 % à 4 et plus, hors péages et TPMR. Abattement de 5 % pour un patient seul sur une longue distance (seuil local, 30 km au moins). Le partage est proposé par défaut ; un refus est mentionné sur la facture.
- Seuls les trajets faits par un conducteur et un véhicule déclarés au référentiel national sont remboursés (art. 5.1). La carte professionnelle doit être valide (art. 3.7).
- **Territoire de l'ADS (art. 5.2) — non revérifié.** Chaque autorisation de stationnement (ADS) doit prendre en charge en majorité des patients de son territoire, une zone fixée par la caisse, d'au moins deux communes du département (art. 3.1). Contrôle annuel, première année de transition, mode de calcul fixé par une charte nationale. Selon une question écrite, il s'agit d'au moins 50 % de l'activité dans la zone de l'ADS, appliqués pleinement depuis le 1er novembre 2026, avec des sanctions qui vont jusqu'au déconventionnement ([QE 11226](https://questions.assemblee-nationale.fr/dyn/17/questions/QANR5L17QE11226), sans réponse du gouvernement). Aujourd'hui, l'optimiseur affecte un taxi à n'importe quelle course de l'axe (13, 04, 05, 38) : un taxi de Sisteron peut prendre un Gap – Marseille.
- **Sous-traitance (art. 7.1) — non revérifié.** Une course ne se confie qu'à une entreprise conventionnée, et l'entreprise qui réalise le transport le facture elle-même, y compris en cas de rétrocession.
- Chaque trajet facturé indique la date, l'heure, les lieux de départ et d'arrivée, l'immatriculation, le conducteur, le nombre de malades, les km en charge et le RPPS du prescripteur (art. 7.3). Le patient signe, ou une mention le remplace (art. 7.2). La caisse contrôle les distances avec un distancier (art. 7.7). Le déconventionnement peut aller jusqu'à 5 ans (art. 9.2).
- SEFi est obligatoire au plus tard le 1er janvier 2027 (art. 7.5) ; il remplace la norme B2.
- Corrections : 15 % et 33 % sont les abattements du VSL certifié (avenant 11), pas du taxi. L'objectif de plus de 30 % de partage fin 2027 vient du protocole des transporteurs sanitaires, pas de la convention taxis.
- Point à recouper : selon la veille concurrence (fiche Lomaco en annexe), la Commission des téléservices a fermé le service SEFi Taxis depuis le 1er octobre 2025 (décision du 16 mars 2026). Comment les taxis tiendront-ils l'échéance du 1er janvier 2027 ?
- Sources : [arrêté du 29 juillet 2025](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052060568) (art. 5.2 et 7.1 compris), [ameli, convention nationale type](https://www.ameli.fr/taxi-conventionne/textes-reference/convention-nationale-type), [QE 11226](https://questions.assemblee-nationale.fr/dyn/17/questions/QANR5L17QE11226).

### VSL et ambulances : protocole du 24 septembre 2025 et SEFi — partiel

- Protocole approuvé par l'arrêté du 29 septembre 2025.
- SEFi est obligatoire pour les transporteurs sanitaires depuis l'avenant 10 (2021), mais sans sanction : 30 % des factures passaient hors SEFi en 2024.
- Depuis le 1er octobre 2025, les tarifs de base baissent de 13 % pour les entreprises non certifiées.
- Flux certifiés, niveaux 3 à 5 (3 = véhicule identifié, 4 = assuré, 5 = conducteur) : le kilométrage du boîtier GPS devient le kilométrage facturé.
- À partir du 1er juillet 2027, le tarif majoré est réservé à ces flux. Objectif : au moins 90 % de flux certifiés en 2027.
- Abattements de partage VSL : 15 % à 2 patients et 33 % à 3 si l'entreprise facture par SEFi avec une flotte géolocalisée certifiée, sinon 23 % et 35 %.
- Objectif : plus de 30 % de transports partagés fin 2027.
- « Jonction » : plusieurs transporteurs se rejoignent et un seul véhicule termine le trajet partagé. Plateformes de commande de transports dans les 32 CHU d'ici fin 2026.
- Repères de la Cour des comptes : cibles implicites pour 2027 de 36 % de partage en VSL et 25 % en taxi ; taux constatés de 21,7 % en VSL en 2024 et d'environ 5 % en taxi.
- Sources : [arrêté du 29 septembre 2025 (protocole)](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052304334), [ameli, tarifs VSL](https://www.ameli.fr/transporteur-sanitaire/exercice-professionnel/facturation/tarifs/vsl-tarifs-conventionnels), [Cour des comptes](https://www.ccomptes.fr/sites/default/files/2026-05/20260527-RALFSS-2026-7-Transports-patients-a-la-charge-de-l-assurance-maladie.pdf).

### Prescription électronique (e-PMT) — à confirmer (source non conservée)

- Les libéraux prescrivent en ligne sur amelipro. La version hospitalière est limitée à 4 établissements.
- 1,5 million de prescriptions électroniques en 2025.
- Aucune obligation trouvée pour 2025-2027 : l'amendement du PLFSS 2025 est « tombé ».
- Source : le mémo du 9 novembre ne garde aucun lien pour ce point (page amelipro, amendement du PLFSS 2025). À retrouver et à relire avant d'en tirer une règle.

### Prise en charge : ALD, accord préalable, établissement le plus proche

- **Décret n° 2026-812 du 21 août 2026 — à confirmer** (texte non lu sur Légifrance). Depuis le 1er octobre 2026, une ALD ne justifie à elle seule un transport que si elle est exonérante. Les autres motifs ne changent pas : hospitalisation, plus de 150 km, série… Une participation de l'assuré de 50 à 60 % entrerait en vigueur au 1er janvier 2027, sous condition. Sources : questions écrites [QE 17933](https://questions.assemblee-nationale.fr/q17/17-17933QE.htm) et [QE 18245](https://questions.assemblee-nationale.fr/q17/17-18245QE.htm).
- **Accord préalable (DAP) — non revérifié.** Il est obligatoire pour un transport de plus de 150 km à l'aller, pour une série d'au moins 4 transports de plus de 50 km à l'aller sur 2 mois pour un même traitement (la page ameli exclut les transports liés à une ALD), et pour l'avion ou le bateau. Sans réponse de la caisse sous 15 jours, l'accord est acquis. Source : [ameli, accord préalable](https://www.ameli.fr/medecin/exercice-liberal/accord-prealable/accord-prealable-transport).
- **Art. R. 322-10-5 du code de la sécurité sociale — non revérifié.** Le remboursement est calculé sur la distance jusqu'à la structure de soins appropriée la plus proche. Source : [Légifrance](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006749252).
- Sur l'axe de V, une série Sisteron – Aix ou Sisteron – Grenoble dépasse 50 km, et un Gap – Marseille dépasse 150 km : l'accord préalable et le plafond de distance y comptent. Rien n'est suivi aujourd'hui dans l'application.

### Autres textes à anticiper — à confirmer (source non conservée)

Le mémo du 9 novembre les cite sans lien ni niveau de vérification. Aucun de ces points n'a été relu : à relire avant d'en faire une règle.

- Loi 2026-534, mesures anti-fraude : paiement différé pendant une procédure (art. 78), responsabilité solidaire du dirigeant (art. 97). Fraude citée : facturer plusieurs trajets simples au lieu d'un trajet partagé. À confirmer : la loi a été lue pour son art. 27 ([Légifrance](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000054309429)), pas pour ces deux articles.
- Décret n° 2026-787 du 13 août 2026 : transport bariatrique (équipage jusqu'à 3 personnes) ; agrément TPMR au 1er janvier 2028. À confirmer : texte non lu, source non conservée.
- LFSS 2026 : mise sous objectif des établissements prescripteurs au 1er janvier 2027 (modalités à préciser). À confirmer : texte non lu, source non conservée.
- ADRi et CDRi : aucune obligation trouvée (non confirmé).

### Ce que cela change pour Opti-Taxi

- **Données dont Opti-Taxi a besoin pour planifier et valider** : la catégorie de soins (une des cinq de l'arrêté, à ajouter), la case « compatible partage » de la prescription (déjà saisie : partage autorisé à l'aller, au retour ou les deux), les conducteurs et véhicules déclarés (à ajouter), le refus horodaté (en place), les heures réelles (saisies par les équipages) et les km par course pour l'export (prévus seulement). L'application a aussi le nombre de patients à bord, l'immatriculation et le conducteur de chaque tournée.
- **Données qui restent dans le logiciel certifié de V** (facturation, hors périmètre) : signature du patient, RPPS du prescripteur, péages, motif de prise en charge (ALD exonérante, hospitalisation, plus de 150 km, série). Opti-Taxi ne les collecte pas : la planification n'en a pas besoin, et ce sont des données de santé (minimisation, RGPD art. 5.1.c). S'il fallait un jour avertir qu'une course ne sera pas remboursée, Opti-Taxi garderait un motif codé, jamais un diagnostic.
- **Validateur** : il vérifie déjà le détour, l'attente, le TAP seul et la prescription. À ajouter : le partage seulement pour les cinq catégories de soins ; aucun conducteur ni véhicule non déclaré sur une course CPAM en taxi conventionné.
- **Territoire de l'ADS (taxis)** : rattacher chaque taxi à son ADS et à son territoire, suivre sur l'année glissante la part de patients du territoire, pénaliser dans l'objectif une prise hors territoire quand un taxi approche du seuil, et faire avertir le validateur. Une pénalité plutôt qu'une contrainte dure, tant que le mode de calcul de la caisse n'est pas connu.
- **Sous-traitance** : un partenaire ne s'enregistre qu'avec son numéro de conventionnement (taxi) ou d'agrément (transport sanitaire) ; il facture lui-même la course confiée, qui sort du chiffre d'affaires et des indicateurs de V.
- **Grilles tarifaires datées** (lot tarifaire à venir) : taxi avec 4 km inclus, km par département d'ADS, grande ville, majorations, retour à vide, TPMR, abattements 23, 35 et 37 % et 5 % en longue distance ; VSL selon la certification (15 et 33 % ou 23 et 35 %, tarif majoré réservé aux flux certifiés dès le 1er juillet 2027).
- **Exports, après le MVP** : V devra être équipé d'un logiciel certifié au 1er janvier 2027 ; l'export d'Opti-Taxi suivra son format. À exporter : le planifié, par course et par patient ; le rapprochement entre le prévu et le GPS ; la liste quotidienne des arrivées partagées par établissement (elle existe déjà, à imprimer).
- **Tableau de bord** : taux de partage par type (repères : 30 % fin 2027, 36 % en VSL, 25 % en taxi), taux de refus, part des flux certifiés.
- **Paramètres plutôt que code** : décret d'application de L. 322-5-3, minoration en cas de refus, jonction, participation de 50 à 60 %.
- Les données de géolocalisation liées à un patient sont des données de santé : hébergeur HDS.

## Faisabilité

Oui, c'est réalisable. C'est un problème d'optimisation connu (le « Dial-a-Ride Problem » : tournées avec prises en charge, déposes et fenêtres horaires), déjà résolu en production dans le transport sanitaire. Le vrai risque n'est pas l'algorithme : c'est l'adoption par le régulateur et la place face au logiciel que V utilise déjà.

**Preuve que ça marche.** Un éditeur de solveur décrit un outil utilisé chaque jour par un grand transporteur sanitaire français : planification du transport assis la veille pour le lendemain, environ 500 missions et 50 véhicules par secteur, une solution en 5 minutes de calcul ([Hexaly](https://www.hexaly.com/wp-content/uploads/2024/02/Operational-planning-of-medical-vehicle-routes.pdf)). Avec environ 120 véhicules, V a plus de véhicules qu'un secteur de ce cas, pour moins de missions : voir « Test de charge » pour ce que cela change.

**Ce qui est simple.**

- Les courses régulières : le planning de la semaine se génère à partir des récurrences.
- La planification de la veille pour le lendemain, l'essentiel de la valeur.
- Les écrans de gestion (patients, véhicules, courses) et la carte.

**Ce qui est difficile.**

| Difficulté | Réponse proposée |
| --- | --- |
| Temps de trajet fiables en montagne et dans le trafic marseillais | OSRM auto-hébergé (gratuit, sans trafic) ralenti par des facteurs par zone et par créneau, calibrés sur les temps réels de V ; API avec trafic (Google, HERE, PTV) si l'écart avec la réalité reste trop fort |
| Heures de retour incertaines (fin de séance variable) | Réoptimisation en journée en version 2 ; durées de séance apprises sur l'historique |
| Le régulateur doit garder la main | L'outil propose, le régulateur valide ; il peut figer une course et réoptimiser le reste |
| Facturation CPAM, télétransmission, kilomètres certifiés | Hors périmètre : rester sur le logiciel certifié de V (obligatoire au 1er janvier 2027), prévoir un export et un import |
| Données de santé (un trajet vers un centre de dialyse révèle une pathologie) | Hébergeur certifié HDS en production, conformité RGPD, données fictives en développement |

**Le marché est déjà équipé.** Huit concurrents français ont été comparés le 9 novembre 2026 (voir « Concurrence »). Les éditeurs historiques (Synovo avec Saphir et EMMAI, Lomaco, SCR Informatiques avec SCR'AMBGES) vendent un logiciel complet centré sur la facturation CPAM certifiée. Plusieurs annoncent une optimisation des tournées et le transport partagé. Aucun ne montre publiquement une optimisation de la journée entière d'une flotte, avec son temps de calcul et des résultats mesurés. Des offres d'emploi de régulateur citent [LOMACO](https://candidat.francetravail.fr/offres/recherche/detail/191MWYJ) ou [SAPHIR](https://candidat.francetravail.fr/offres/recherche/detail/211ZHGB).

**Recommandation.** Construire un module d'optimisation de planning qui s'ajoute au logiciel certifié de V, plutôt qu'un ERP complet. Savoir d'abord quel logiciel V utilise et ce qui lui manque. S'il annonce déjà une optimisation (SCR'AMBGES, Saphir avec EMMAI, Lomaco), la valeur ajoutée est à démontrer sur l'historique de V.

## Concurrence (vérifiée le 9 novembre 2026)

Les concurrents forment quatre familles. Les éditeurs historiques (Lomaco, SCR Informatiques, Synovo avec Saphir) vendent un logiciel complet centré sur la facturation CPAM certifiée, avec régulation, personnel et flotte. Les nouveaux entrants (Drivesoft, Ondy, et Becose, pas encore lancé) vendent une suite à prix public par véhicule et par mois. SanteMobile fait la régulation sans facturation pour 3 à 20 véhicules ; Amblea est une plateforme où les établissements commandent des transports, qu'elle répartit entre transporteurs. Aucun ne montre publiquement une optimisation de la journée entière d'une flotte avec temps de calcul et résultats mesurés, ni un transport partagé dont le détour, l'attente et le refus sont à la fois contrôlés et tracés. Opti-Taxi se place là : planifier J+1 toute la flotte sous contraintes vérifiées (détour, attente, TAP et refus contrôlés ; catégories de soins du décret à ajouter), en amont du logiciel de facturation déjà en place, sans le remplacer.

> Identification : les huit produits sont identifiés. Pour Becose, l'éditeur n'est établi que par recoupement (même téléphone et même adresse). Le lien entre Synovo et le logiciel taxi Caree n'est pas établi.

### Grille comparative

| Capacité | Synovo (Saphir, EMMAI) | Lomaco | SCR (SCR'AMBGES) | Drivesoft | Ondy | SanteMobile | Amblea | Becose | Opti-Taxi |
|---|---|---|---|---|---|---|---|---|---|
| 1. Régulation, planning (frise, glisser-déposer, temps réel) | ✔ fait | ✔ fait | ◐ annoncé | ◐ annoncé | ✔ fait | ◐ annoncé | ◐ annoncé (a) | ◐ annoncé | ✔ partiel (j) |
| 2. Optimisation automatique des tournées (J+1 ou jour J) | ◐ annoncé | ◐ annoncé | ◐ annoncé | ◐ annoncé | ? | ◐ annoncé | ✔ partiel (b) | ◐ annoncé | ✔ en place (k) |
| 3. Transport partagé selon le décret 2025-202 (proposition, détour, attente, refus) | ◐ annoncé | ◐ annoncé | ◐ annoncé | ? | ◐ annoncé | ◐ annoncé | ✔ partiel (b) | ◐ annoncé | ✔ partiel (l) |
| 4. Application chauffeur (statuts, hors ligne, signature, photo PMT) | ✔ fait | ✔ fait | ◐ annoncé | ✔ fait | ✔ fait | ✔ fait | ✔ fait | ◐ annoncé | ✔ partiel (m) |
| 5. Géolocalisation certifiée et SEFi (échéance 1er janvier 2027) | ◐ annoncé (c) | ◐ annoncé (d) | ◐ annoncé | ✔ partiel (e) | ◐ annoncé | ✘ non | ? | ◐ annoncé | ✘ non (n) |
| 6. Facturation CPAM et télétransmission | ◐ annoncé | ✔ fait | ◐ annoncé | ✔ fait | ✔ partiel (f) | ✘ non | ? | ◐ annoncé | ✘ non (n) |
| 7. Planning du personnel (congés, gardes, heures, paie) | ◐ annoncé | ◐ annoncé | ◐ annoncé | ◐ annoncé | ? | ✔ partiel (g) | ? | ? | ✔ partiel (o) |
| 8. Flotte (entretien, échéances, désinfection, stocks) | ◐ annoncé | ? | ◐ annoncé | ◐ annoncé | ? | ◐ annoncé | ? | ? | ✔ partiel (p) |
| 9. Commandes des établissements (portail, plateformes, API) | ✔ fait | ✔ fait | ◐ annoncé | ◐ annoncé | ✔ fait | ? | ✔ fait | ◐ annoncé | ✘ non (q) |
| 10. Information des patients (SMS, suivi) | ◐ annoncé | ✔ fait | ◐ annoncé | ? | ✔ fait | ✔ fait | ◐ annoncé | ? | ✘ non |
| 11. Échange de courses entre transporteurs, sous-traitance | ◐ annoncé | ? | ◐ annoncé (h) | ? | ✔ fait | ? | ✔ fait | ? | ✘ non (r) |
| 12. Export ou API vers d'autres logiciels | ◐ annoncé | ✔ fait | ◐ annoncé | ◐ annoncé | ✔ fait | ◐ annoncé | ✔ fait | ? | ✘ non (s) |
| 13. Hébergement HDS | ◐ annoncé | ◐ annoncé | ? | ◐ annoncé | ? | ✘ non | ? | ◐ annoncé | ✘ non (t) |
| 14. Prix publié | ✘ non | ✔ partiel (i) | ✘ non | ✔ fait | ✔ fait | ✘ non | ✘ non | ◐ annoncé | ✘ non (u) |

Légende : **✔ fait** = vérifié hors de la page commerciale de l'éditeur (registre officiel, store d'applications, presse, document tiers). **✔ partiel** = vérifié de la même façon, mais pour une partie seulement de la ligne ; la note dit ce qui manque. **◐ annoncé** = affirmé seulement sur la page commerciale. **✘ non** = l'éditeur écrit qu'il ne le fait pas, ou aucun prix n'est publié. **?** = aucune information trouvée. Les fiches en annexe donnent le détail.

- (a) Amblea : la régulation est assurée par une équipe d'Amblea ; le transporteur n'a pas de planning de flotte.
- (b) Amblea : partiel. Regroupements et enchaînements proposés mission par mission, sans optimisation de la journée d'un véhicule ; ni décret cité, ni refus tracé.
- (c) Synovo : SEFi annoncé ; aucune certification de géolocalisation revendiquée.
- (d) Lomaco : aucune certification trouvée sur ses pages, mais le catalogue SESAM-Vitale cite Lomaco Online en SEFi 03.50 ; à revérifier.
- (e) Drivesoft : labels GEO et SEFi pour le transport sanitaire seulement, pas pour le taxi.
- (f) Ondy : taxi seulement ; certification CNDA affirmée par l'éditeur, non vérifiée au catalogue SESAM-Vitale.
- (g) SanteMobile : congés et absences seulement ; selon l'éditeur, ni amplitude, ni repos, ni paie.
- (h) SCR : bourse de transport côté hôpital (LCR_i), pas d'échange direct entre sociétés.
- (i) Lomaco : prix public pour le taxi conventionné seulement.

Colonne Opti-Taxi : vérifiée dans le code de l'application au 9 novembre 2026 (commit 7954db2), pas sur une page commerciale. **✔ en place** = la capacité existe dans l'application. **✔ partiel** = une partie existe ; la note dit ce qui manque. **✘ non** = absente.

- (j) Opti-Taxi : frise par véhicule, carte et panneau « À traiter ». Une course se déplace par « Déplacer vers… », puis l'outil recalcule la journée ; pas de glisser-déposer. Les statuts saisis par les équipages s'affichent au rechargement de la page, sans suivi en direct. Une fois la journée commencée, plus de recalcul ni de déplacement.
- (k) Opti-Taxi : « Optimiser demain » calcule les tournées de toute la flotte (OR-Tools et insertion), puis un validateur indépendant revérifie chaque règle dure. Banc fictif de 120 véhicules et 300 voyages : 297 courses placées sur 297 en 15 s (voir « Test de charge »). Pas de recalcul du jour même une fois la journée commencée.
- (l) Opti-Taxi : détour (10 km par patient ajouté, 30 km au plus) et attente (45 min), réglables sans dépasser ces plafonds ; partage en TAP seulement, si la prescription l'autorise ; proposition horodatée ; acceptation et refus tracés (auteur, heure) ; feuille des arrivées partagées par établissement, à imprimer. Manque : les cinq catégories de soins de l'arrêté du 28 février 2025. Le partage dépend seulement de la prescription : il est proposé, et un refus peut être tracé, pour un soin hors de ces catégories.
- (m) Opti-Taxi : feuille de route web sur téléphone, statuts « pris en charge », « déposé » et « patient absent », file des statuts hors réseau à l'heure du geste, lien vers l'application de navigation. Ni signature, ni photo de la PMT, ni copie de la feuille de route hors réseau.
- (n) Opti-Taxi : hors périmètre. Aucune géolocalisation, aucune facture : seulement un chiffre d'affaires estimé par course, à partir de grilles tarifaires datées en base.
- (o) Opti-Taxi : absences datées (congé, maladie, formation, garde), jours et horaires habituels, pause, paires interdites, équipages du jour avec remplaçants proposés. Ni heures réalisées, ni amplitude, ni repos entre deux jours, ni paie.
- (p) Opti-Taxi : indisponibilités datées, échéances (contrôle technique, révision, pneus, assurance) avec alerte à 30 jours ou 1 000 km, pleins et consommation. Ni désinfection, ni stocks.
- (q) Opti-Taxi : la régulation saisit les séries et les courses ponctuelles ; aucun portail ni import.
- (r) Opti-Taxi : seulement le motif d'annulation « Confiée à un confrère ».
- (s) Opti-Taxi : aucun export ni API ; seule la feuille des arrivées partagées s'imprime.
- (t) Opti-Taxi : pas encore d'hébergement de production ; la démo ne contient que des données fictives. Le journal d'audit des accès aux données de santé est en place.
- (u) Opti-Taxi : pas d'offre commerciale.

Les fiches détaillées des huit concurrents, avec leurs sources numérotées, sont en annexe (« Annexe : fiches des concurrents »).

### Ce qu'Opti-Taxi en retient (pistes à valider)

1. Montrer en démonstration ce qu'aucun concurrent ne montre publiquement : une optimisation J+1 de toute la flotte, avec son temps de calcul et ses gains mesurés (courses par véhicule, km à vide, part de partage, retards), chaque solution passant par le validateur indépendant.
2. Rendre visible le transport partagé selon le décret 2025-202 : regroupements proposés, détour borné à 10 km par patient et 30 km au total, attente bornée à 45 min, refus tracé sur la course. Ajouter d'abord les cinq catégories de soins de l'arrêté : sans elles, le partage peut être proposé, et un refus tracé, hors du champ du décret.
3. Mettre en avant l'équipage du jour (absences, paires interdites, véhicules indisponibles, pauses), car aucun concurrent ne décrit de paires interdites ni de véhicules indisponibles pris en compte dans la planification.
4. Exporter les tournées et les courses réalisées vers le logiciel de facturation certifié du client, d'abord en CSV puisque Lomaco, SCR et Saphir ne publient pas d'API, et demander au PO lequel il utilise (Lomaco a une instance à Grenoble ; Ondy revendique environ 100 sociétés dans les Bouches-du-Rhône).
5. Garder la règle « l'outil propose, le régulateur décide » : propositions visibles avant validation, courses figées, et réoptimisation du reste quand une course est ajoutée ou refusée.
6. Recevoir dans une boîte de réception du planning les commandes venant des établissements (Amblea, Rubis, SPS, LCR_i en Isère), sans ressaisie.
7. Pour la sous-traitance demandée par le PO, confier une course non affectée à un confrère conventionné, qui la facture lui-même (convention taxis, art. 7.1). Une fois le cadre RGPD validé : un lien à usage limité et expirant, qui ne montre que le strict nécessaire (prise en charge, dépose, horaire, mode prescrit), dont chaque ouverture est tracée dans le journal d'audit, sur un hébergement HDS. Ondy sert de repère pour la simplicité d'usage, pas pour le traitement des données (hébergement non certifié HDS, données non chiffrées selon sa fiche Google Play). Un échange de courses comme Rubis Exchange peut venir ensuite.
8. Ne promettre ni SEFi ni géolocalisation certifiée pour le 1er janvier 2027, mais savoir importer les traces et les statuts d'un boîtier certifié.
9. Publier un prix par véhicule et par mois, multi-dépôts compris : les repères sont 50 € HT chez Ondy (6 000 € HT par mois pour 120 véhicules) et environ 78 € HT chez Drivesoft, qui impose sa formule Premium au-delà de 50 véhicules.
10. Afficher l'éditeur, l'hébergeur HDS, ce qui est certifié et ce qui n'est qu'annoncé, avec des chiffres issus du banc d'essai, car Ondy, Becose et Drivesoft se contredisent sur ces points.

## Solution proposée

Un outil web à deux faces : un écran de planification pour le régulateur, une feuille de route mobile pour les chauffeurs. Son cœur est un bouton « Optimiser demain » qui propose les tournées de chaque véhicule, que le régulateur ajuste puis valide.

**MVP (version 1).**

1. Référentiel : patients (adresse, mobilité, partage autorisé ou non), établissements de soins, véhicules (type, capacité, dépôt), chauffeurs (qualifications, horaires).
2. Courses et récurrences : saisir une fois « dialyse lundi, mercredi, vendredi, RDV 7 h 30 », puis générer automatiquement les courses de la semaine.
3. Optimisation J+1 : tournées par véhicule, regroupements proposés, et pour chaque tournée les kilomètres, les kilomètres à vide et le chiffre d'affaires estimé.
4. Ajustement manuel : déplacer une course d'un véhicule à l'autre, la figer, relancer l'optimisation sur le reste.
5. Feuille de route chauffeur (application web mobile) : ordre des arrêts, adresses, lien vers le GPS, statut « pris en charge / déposé ».
6. Traçabilité du partage : proposition faite, acceptée ou refusée, par patient et par course.
7. Tableau de bord : les cinq indicateurs du besoin, jour par jour.

**Version 2.**

- Réoptimisation en journée (course urgente, retard, séance qui finit plus tôt).
- Positions et kilomètres réels importés du boîtier certifié de V, plutôt qu'un suivi GPS refait ; SMS de confirmation aux patients.
- Alertes sur les prescriptions qui arrivent à expiration.
- Durées de séance et temps de trajet appris sur l'historique.
- Export vers le logiciel certifié de V. C'est V qui devra être équipé au 1er janvier 2027 (géolocalisation certifiée et facturation intégrée) ; l'export d'Opti-Taxi suivra le format de ce logiciel (voir « Réglementation 2025-2027 »).

**Hors périmètre.** Facturation CPAM et télétransmission, prise d'appels, transports d'urgence (exclus du transport partagé par le décret).

## Besoins ajoutés par le PO (6 novembre 2026)

L'appel élargit le produit : au-delà des tournées, V veut planifier son personnel et sa flotte. Lecture des notes prises pendant l'appel, à valider avec le PO :

| Note | Lecture | Existant dans l'application | À confirmer |
| --- | --- | --- | --- |
| Planning chauffeur, congés, week-ends, gardes | Savoir qui travaille à une date donnée, pas seulement selon une semaine type | Jours et horaires fixes par chauffeur, sans exception datée | Une garde bloque-t-elle un équipage et un véhicule ? |
| Personnel : ambulanciers par paires, accompagnants | Former les équipages du jour selon l'entente entre employés (paires possibles ou non) | Équipier possible sur le véhicule et la tournée, sans notion d'entente | « Accompagnant » = employé, ou proche du patient qui prend une place ? |
| Planning voitures : consommation, révision, entretien | Bloquer un véhicule en entretien, suivre ses échéances et sa consommation | Véhicule actif ou non, coût au km unique | Saisie dans l'outil ou import depuis un logiciel existant ? |
| Préférence du client pour un type de véhicule ou un chauffeur | Préférence prise en compte sans jamais passer outre la prescription | Rien | Préférence ou exigence ? |
| Gestion d'affinités | Entre collègues d'après les notes ; peut-être aussi patient–chauffeur et patient–patient en partage | Rien | Lesquelles retenir ? |
| Cotation du prix du véhicule pour le trajet (Sisteron – Grenoble en diesel, Sisteron – Aix en électrique) | Choisir le véhicule le plus rentable pour le trajet : énergie, consommation, autonomie | Coût au km par véhicule, sans énergie ni autonomie | Coût interne ou devis au client ? Autonomie ou coût ? Où recharger ? |
| Dépôts dans différentes villes | Dépôt = lieu de rattachement des véhicules et du personnel | Chaque véhicule a déjà son dépôt, saisi en texte et coordonnées | Un véhicule peut-il finir sa journée dans un autre dépôt ? |
| Partage de clients, sous-traitance (entre parenthèses dans les notes) | Confier à un partenaire les courses non couvertes, ou en recevoir | Rien | Dans quel sens ? Pour plus tard ? Transmettre des données de santé à un tiers demande un cadre RGPD |

**Ce que cela change au positionnement.** La recommandation était un module ajouté au logiciel de V, pas un ERP. Plannings du personnel et suivi de flotte s'en rapprochent : si le logiciel actuel de V les gère, mieux vaut les importer que les refaire. La question du logiciel actuel reste la première à poser.

**Plan proposé, un lot à la fois, chacun validé avant le suivant :**

1. Cadrage et test de charge à l'échelle annoncée (fait le 7 novembre, voir « Test de charge »).
2. Dépôts : entité à part, véhicules et personnel rattachés. Fait le 7 novembre : page Dépôts (création, modification, désactivation refusée tant que des véhicules actifs y sont rattachés), un dépôt obligatoire par véhicule, un dépôt de rattachement facultatif par chauffeur. La migration crée un dépôt par lieu distinct des véhicules existants et rattache chaque chauffeur au dépôt de son véhicule attitré. Le département de tarification reste sur le véhicule. Déplacer un dépôt ne recalcule pas les tournées déjà proposées : l'écran indique les jours à réoptimiser.
3. Planning du personnel : congés, week-ends, gardes par date, équipages du jour avec paires interdites. Fait le 8 novembre :
   - absences datées dans la fiche chauffeur (congé, arrêt maladie, formation, garde, autre) : la personne n'est pas planifiée ces jours-là. Une garde est traitée comme une absence pour la journée entière ; le véhicule de garde sera bloqué avec le planning des véhicules (lot 4) ;
   - paires interdites dans la fiche chauffeur : jamais proposées ensemble, refusées dans un équipage fixé ;
   - page Équipages, par date : chaque véhicule reçoit son équipage attitré s'il est disponible, sinon un remplaçant qualifié et libre, du même dépôt d'abord, puis du dépôt le plus proche dans la limite réglée (60 km par défaut), qui couvre l'horaire du titulaire, en gardant les ambulanciers DE pour les ambulances. Le régulateur modifie les lignes voulues et enregistre : seules ces lignes sont fixées pour ce jour (refusé si un collègue a modifié la même ligne entre-temps), chacune peut revenir à la proposition. Si une personne fixée devient absente, l'autre membre est gardé et un remplaçant proposé. Un week-end se planifie en y affectant quelqu'un hors de ses jours habituels (signalé, accepté) ;
   - ambulance : deux personnes auxiliaires ou ambulanciers DE, dont au moins un ambulancier DE, quel que soit le conducteur (art. R. 6312-10 du code de la santé publique), et un horaire commun minimal (4 h par défaut) ;
   - l'optimisation, le planning et les déplacements de courses utilisent l'équipage du jour, et chaque tournée enregistrée garde l'équipage avec lequel elle a été calculée. Sur une journée validée ou commencée, « Changer l'équipage » (panneau du véhicule du planning) remplace le chauffeur ou l'équipier d'une tournée non terminée sans toucher à ses arrêts : la feuille de route passe aussitôt au remplaçant.
4. Planning des véhicules : indisponibilités, échéances d'entretien avec alertes, consommation ; l'optimiseur ignore un véhicule indisponible. Fait le 8 novembre, dans la fiche véhicule :
   - indisponibilités datées (entretien, réparation, contrôle technique, garde, autre) : le véhicule n'est pas planifié ces jours-là, et son équipage attitré est proposé sur d'autres véhicules. Une garde se saisit donc deux fois : la personne (absence « garde ») et le véhicule (indisponibilité « garde ») ;
   - échéances à une date, à un kilométrage ou au premier des deux (contrôle technique, révision, pneumatiques, assurance, autre), avec alerte à 30 jours ou 1 000 km dans la liste des véhicules ; « marquer comme faite » relève la date et le dernier kilométrage connu ;
   - pleins et recharges (date, compteur, quantité, montant, plein complet) : dernier relevé du compteur, consommation mesurée entre pleins complets (L ou kWh aux 100 km selon l'énergie du véhicule) et coût de l'énergie au km, à comparer au coût au km utilisé par l'optimiseur.
5. Coût et autonomie par véhicule (énergie, consommation) : le choix diesel / électrique découle de la marge, plus une contrainte d'autonomie revérifiée par le validateur.
6. Préférences et affinités patient : bonus ou pénalités dans l'objectif ; seules les exigences explicites deviennent des contraintes dures.
7. Sous-traitance, plus tard.

**Choix structurant, validé le 8 novembre.** Avant, le chauffeur venait du véhicule (chauffeur attitré). Décision : fixer d'abord les équipages du jour (proposés automatiquement, ajustés par le régulateur), puis calculer les tournées avec ces équipages. C'est plus simple et plus lisible qu'un calcul simultané, et cela devrait mieux tenir à 120 véhicules. En contrepartie, la solution peut être un peu moins optimale, et une préférence pour un chauffeur reste limitée par les équipages déjà fixés.

## Moteur d'optimisation

Chaque soir, le moteur affecte chaque course à un véhicule et ordonne les arrêts pour maximiser la marge de la journée, sans violer aucune règle. En recherche opérationnelle, c'est un problème de tournées avec prises en charge, déposes et fenêtres horaires (PDPTW, ou Dial-a-Ride).

**Formulation.**

- Une course = une paire prise en charge → dépose, avec une fenêtre horaire (arriver avant le RDV, repartir après la séance).
- Un véhicule part de son dépôt et y revient, avec un type (taxi, VSL, ambulance), une capacité (1 ou 2) et un chauffeur aux horaires connus.
- Contraintes dures : type compatible, capacité, fenêtres horaires, détour ≤ 10 km pour un patient partagé, attente ≤ 45 min au lieu de soins (attente à bord du véhicule garé devant l'établissement comprise), temps à bord ≤ trajet direct + 30 min (réglable), patients non partageables seuls à bord, horaires et pauses des chauffeurs, pas de tournée de plus de 6 h sans pause de 20 min (Code du travail, art. L. 3121-16).
- Attente de 45 min : en V1, découper ce budget en deux paramètres réglables (une marge avant le RDV, une après la séance), dont la somme ne dépasse pas 45 min.
- Temps d'arrêt : par mode de transport (ambulance, ou taxi et VSL), plus une majoration par mobilité du patient (fauteuil, allongé) et par établissement.

**Objectif.** Maximiser la marge estimée, avec une forte pénalité par course non affectée pour que le régulateur la voie tout de suite. Le cas Hexaly vise plutôt le chiffre d'affaires par heure travaillée, une variante à tester.

```latex
\max \; \sum_{c \,\in\, \text{courses servies}} \text{CA}_c \;-\; \sum_{v \,\in\, \text{véhicules}} \left( \text{km}_v \cdot c_{\text{km}} + \text{heures}_v \cdot c_{\text{h}} \right) \;-\; P \cdot N_{\text{non affectées}}
```

Raisonner en marge plutôt qu'en nombre de courses compte ici : un partage baisse le prix par patient (abattement) mais économise des kilomètres et du temps chauffeur. C'est aussi ce qui fera choisir taxi ou VSL selon la distance.

**Outils.**

| Brique | Choix proposé | Pourquoi |
| --- | --- | --- |
| Solveur | Google OR-Tools (Python), routage avec paires prise en charge / dépose | Gratuit ; gère fenêtres horaires, capacités, véhicules autorisés par course ; le détour maximal s'exprime avec une dimension de distance |
| Alternative pour prototyper vite | VROOM | Moteur open source appelé en HTTP, simple à brancher depuis Node, mais moins souple pour les contraintes de détour |
| Distances et temps de trajet | OSRM auto-hébergé, extraits OpenStreetMap PACA + Auvergne-Rhône-Alpes | Gratuit ; matrice de temps calculée localement |
| Taille du problème | Environ 120 véhicules et 300 voyages par jour (PO, 6 novembre 2026) | Le cas Hexaly traite 500 missions en 5 minutes ; chez V, c'est le nombre de véhicules qui pèse (voir « Test de charge ») |

## Test de charge (7 novembre 2026)

Le service d'optimisation a été lancé sur une journée fictive à l'échelle annoncée par le PO : 120 véhicules répartis sur 6 dépôts (Marseille, Aix, Manosque, Sisteron, Gap, Grenoble), 50 % de taxis, 35 % de VSL, 15 % d'ambulances, pause du midi pour 7 chauffeurs sur 8 ; 150 patients en aller-retour, dont la moitié soignés hors de leur ville (Sisteron – Grenoble, Sisteron – Aix, Gap – Marseille…), et les réglages de trafic par défaut du web. Distances à vol d'oiseau, machine de développement, 1,5 cœur par calcul. Générateur : `fleet_day()` dans `services/optimizer/tests/builders.py` ; banc : `services/optimizer/tests/bench_fleet.py`.

**Résultat : à cette taille, « Optimiser demain » renvoie un planning vide.** Le web accorde au solveur 1 s par tranche de 8 courses (38 s pour 300 voyages). Ce budget ne suffit pas à la première étape du solveur, la construction initiale d'OR-Tools, qui est coupée sans avoir placé une seule course. Le planning vide ne viole aucune contrainte : il est déclaré valide, puis enregistré à la place des tournées déjà proposées pour la journée.

| Scénario | Construction du modèle | Construction initiale OR-Tools | Courses placées au budget du web | Mémoire |
| --- | --- | --- | --- | --- |
| 120 véhicules, 300 voyages (budget 38 s) | 13 s | 57 s (coupée à 47 s) | 0 sur 297 atteignables, réponse en 60 s | 1,9 Go |
| 120 véhicules, 480 voyages (budget 60 s) | 28 s | coupée à 73 s sans avoir fini | 0 sur 476, réponse en 102 s | 4,0 Go |
| 120 véhicules, 300 voyages, sans pause | 1,4 s | non mesurée | non mesuré | 0,35 Go |

**Le problème n'est pas trop gros : c'est l'ordre des étapes du solveur.** La seconde construction, écrite en Python (insertion par regret), place toutes les courses atteignables en quelques secondes, avec un planning valide : 297 sur 297 en 3,3 s pour 300 voyages, 474 sur 476 en 7,4 s pour 480 voyages. Résultat identique sur un autre tirage du jeu fictif (294 sur 294) et avec 20 % de longs trajets au lieu de 50 % (297 sur 297). Quand la construction d'OR-Tools a le temps de finir, c'est d'ailleurs ce planning Python qui est retenu, car meilleur. Il manque seulement de le construire en premier.

| Budget accordé au solveur (300 voyages) | Courses placées | Véhicules utilisés | Km | Réponse |
| --- | --- | --- | --- | --- |
| 38 s (budget actuel du web) | 0 | 0 | 0 | 60 s |
| Insertion Python seule (mesure hors service) | 297 | 74 | 16 675 | 17 s (dont 13 s de construction du modèle) |
| Insertion Python puis 38 s de recherche locale (mesure hors service) | 297 | 74 | 16 706 | 57 s |
| 120 s | 297 | 74 | 16 706 | 134 s |
| 300 s | 297 | 75 | 16 667 | 318 s |
| 600 s | 297 | 77 | 16 540 | 614 s |

La recherche locale apporte peu à cette taille (moins de 1 % de km en moins après 10 minutes). Les 3 courses non placées ont des horaires inatteignables par construction du jeu fictif.

**Ce qui pèse : les lieux de pause.** Chaque chauffeur dispose de jusqu'à 24 lieux de pause candidats (dépôt, établissements, domiciles). À 120 véhicules, ils font 64 % des nœuds du modèle (1 286 sur 2 000) ; sans eux, la construction du modèle passe de 13 s à 1,4 s et la mémoire de 1,9 Go à 0,35 Go.

**Correctifs :**

1. Fait (7 novembre) — solveur : le planning Python est construit en premier et confirmé aussitôt par OR-Tools ; la construction d'OR-Tools vient ensuite et ne le remplace que par un planning moins coûteux. On ne renvoie plus jamais un planning plus pauvre que le planning Python.
2. Mesuré et écarté (7 novembre) — solveur : limiter les lieux de pause candidats par véhicule (12 aujourd'hui) n'améliore pas les tournées. À 30 et 60 véhicules, on perd des courses (147 servies avec 12 lieux, 146 avec 6, 143 avec 2 sur 160 courses ; 287, 287 puis 275 sur 300). À 120 véhicules, avec 6 ou 4 lieux, les écarts vont dans les deux sens (−3 % à +1 % de km) : c'est du bruit de l'heuristique, pas un gain. Avec 2 lieux, la construction d'OR-Tools a enfin le temps de finir, mais les tournées sont plus longues de 5 % (17 538 km contre 16 675) et, à 480 voyages, 3 courses de moins sont servies.
3. Fait (7 novembre) — web : un planning qui ne sert aucune course alors que des courses étaient envoyées n'est plus enregistré. L'optimisation échoue avec le motif le plus fréquent, et le planning en place est conservé.
4. Fait (7 novembre), côté optimiseur — la construction du modèle est comptée dans le budget, que la marge du web (budget plus 30 s) n'avait pas à absorber en plus.
5. Fait (9 novembre) — solveur : la construction initiale d'OR-Tools n'est plus lancée quand sa loi de temps (environ 8·10⁻⁹ × nœuds³ s) dit qu'elle ne peut pas finir dans le temps restant ; le planning Python part aussitôt.
6. Fait (9 novembre) — solveur : le coût au km propre à chaque véhicule passe sur la dimension distance ; les arcs ne gardent qu'une matrice par grille tarifaire (au plus une par type de véhicule et département) au lieu d'une par coût au km. Indispensable avant le coût par énergie (lot 5).

**Après les correctifs 1 et 4,** au budget envoyé par le web : 297 voyages placés sur 297 en 49 s pour 300 voyages (le web attend jusqu'à 68 s), 474 sur 476 en 74 s pour 480 voyages (jusqu'à 90 s). La construction d'OR-Tools n'a toujours pas le temps de finir à cette taille : le planning est celui de l'insertion Python, sans recherche locale, ce qui coûte environ 1 % de kilomètres d'après les mesures ci-dessus. Sur les journées plus petites (60 à 300 courses, 10 à 60 véhicules), avant et après donnent le même nombre de courses servies (une de plus sur l'une d'elles) et les mêmes kilomètres à 0,1 % près.

**Après les correctifs 5 et 6 (9 novembre),** au même budget : réponse en 15 s pour 300 voyages (297 sur 297, 0,32 Go de mémoire au lieu de 1,9 Go) et en 31 s pour 480 voyages (473 sur 476, 0,56 Go au lieu de 4,0 Go). Avec les règles d'avant, le planning est exactement le même qu'au 7 novembre (en 14 et 29 s) : les écarts de courses et de partage viennent des règles ajoutées le même jour (attente à bord devant le lieu de soins comptée dans les 45 min, temps à bord limité, 6 h au plus sans pause), que les plannings d'avant ne respectaient pas. Le web attend toujours le budget plus 30 s.

**Une piste métier, à vérifier sur l'historique réel.** Sur ce jeu fictif, environ 300 voyages tiennent sur 61 à 77 véhicules (4 à 5 voyages par véhicule utilisé), contre environ 2,5 annoncés par véhicule chez V. L'écart vient peut-être des hypothèses du jeu : distances à vol d'oiseau, aucun véhicule ni chauffeur indisponible, rendez-vous répartis sur la journée, trajets plus courts que les vrais. C'est précisément ce que l'historique de V permettra de trancher (Feuille de route, phase 1). Les montants de marge du jeu fictif ne disent rien : les coûts y sont inventés.

## Modèle de données

Neuf entités suffisent pour le MVP ; la course est le pivot, la tournée est ce que produit l'optimiseur. Le dépôt est devenu une dixième entité le 7 novembre (lot 2).

| Entité | Champs clés | Relations |
| --- | --- | --- |
| Patient | nom, adresse géocodée, téléphone, mobilité (assis, fauteuil, allongé), notes d'accès | a des prescriptions, des récurrences, des courses |
| Établissement | nom, adresse géocodée, type (CHU, centre de dialyse, radiothérapie…) | destination des courses |
| Prescription | mode prescrit (taxi/VSL, ambulance), partage autorisé (aller, retour, les deux, non), début et fin de validité, série oui/non | appartient à un patient |
| Récurrence | jours, heure de RDV, durée de séance estimée, aller et/ou retour | patient → établissement ; génère des courses |
| Course | date, origine, destination, fenêtre horaire, type de véhicule requis, statut, partage proposé / accepté / refusé, verrou manuel | liée à une prescription ; placée dans une tournée |
| Véhicule | immatriculation, type, capacité, département de tarification, coût kilométrique | rattaché à un dépôt ; affecté à des tournées |
| Chauffeur | qualifications (taxi, auxiliaire, ambulancier DE), horaires, pauses | rattaché ou non à un dépôt ; affecté à des tournées |
| Dépôt | nom, adresse, coordonnées, notes, actif | départ et retour des tournées de ses véhicules ; rattachement du personnel |
| Tournée | date, véhicule, chauffeur, arrêts ordonnés avec heures prévues, km, km à vide, CA estimé, statut (proposée, validée) | regroupe des courses |
| Grille tarifaire | type de transport, département, forfait, prix au km, abattement de partage, dates de validité | sert au calcul du CA estimé |

## Architecture et stack technique

Une application Next.js en TypeScript porte les écrans et l'API ; seul le calcul des tournées part dans un petit service Python, car OR-Tools n'a pas de version JavaScript officielle.

&#91;embedded content: architecture · 6 briques, hébergement HDS\]

Le régulateur et les chauffeurs passent par la même application ; l'export vers le logiciel de facturation (en pointillé) vient après le MVP.

| Brique | Technologie | Remarque |
| --- | --- | --- |
| Interface régulateur et chauffeurs | Next.js (App Router), TypeScript, Tailwind, MapLibre GL | Application web mobile pour les chauffeurs : pas de store à gérer |
| Base de données | PostgreSQL + Prisma (SQL Server possible) | PostGIS utile plus tard pour les requêtes géographiques |
| Optimisation | Python, FastAPI, Google OR-Tools | Contrat JSON typé : zod côté TypeScript, pydantic côté Python |
| Temps de trajet | OSRM en Docker, facteurs de trafic par zone et créneau | Remplaçable par une API avec trafic si besoin (`TrafficProvider`) |
| Hébergement | Hébergeur certifié HDS | Obligatoire dès qu'il y a de vraies données patients |

## Feuille de route

Le premier livrable n'est pas l'application : c'est la preuve, sur l'historique réel de V, que l'optimiseur fait mieux que le planning manuel.

&#91;embedded content: feuille de route · 5 phases, 5 feux verts\]

Chaque phase ne démarre que si le feu vert précédent est passé ; si le prototype ne bat pas le planning manuel, le projet s'arrête là, à faible coût.

## Questions à poser au client

Mise à jour le 9 novembre 2026. La première série passe avant tout : au 1er janvier 2027 au plus tard, chaque véhicule de V aura une géolocalisation certifiée et une facturation électronique intégrée (loi 2026-534, art. 27). Opti-Taxi doit se brancher sur ce logiciel certifié, pas le remplacer. Les questions « Ensuite » décident si le projet vaut la peine ; les autres fixent les paramètres du moteur. Entre parenthèses, l'hypothèse retenue en attendant la réponse.

**D'abord : le logiciel certifié de V**

- [ ] Quel logiciel utilisez-vous pour la facturation et la télétransmission (éditeur, produit, version) ? Est-il certifié SEFi ? Quel boîtier de géolocalisation équipe les véhicules, et est-il certifié par l'Assurance maladie ? (inconnu ; aucun lot n'en dépend encore)
- [ ] Ce logiciel fait-il aussi la régulation, le planning du personnel et l'entretien ? Que lui manque-t-il ? S'il gère déjà le personnel et l'entretien, les lots correspondants d'Opti-Taxi se réduisent à un import.
- [ ] Sait-il importer des courses planifiées et exporter les courses réalisées (fichier CSV, API) ? Pouvez-vous nous donner un modèle de fichier, colonnes seulement ? (export CSV d'abord : Lomaco, SCR et Saphir ne publient pas d'API)
- [ ] Vos VSL et ambulances sont-ils en flux certifiés, c'est-à-dire SEFi et géolocalisation certifiée sur tous les véhicules ? Cela fixe le tarif et l'abattement de partage du VSL : 15 % et 33 %, ou 23 % et 35 %, et le forfait de l'ambulance : 57,39 € ou 45,60 €. (démonstration : certifiée depuis le 01/01/2025, grilles majorées ; la période se saisit dans Grilles tarifaires › Règles de facturation)
- [ ] Taxis : comment votre éditeur tiendra-t-il SEFi au 1er janvier 2027, alors que le service SEFi Taxis serait fermé depuis le 1er octobre 2025 (à recouper) ?
- [ ] Recevez-vous des commandes par une plateforme d'établissement (Amblea, LCR_i, Rubis Santé, SPS, plateforme d'un CHU) ? Lesquelles, et pour quelle part des courses ? (aucune : la régulation saisit tout)

**Ensuite : la valeur du projet**

- [ ] Qui fait le planning, comment, et combien de temps cela prend-il chaque jour ?
- [ ] Quel objectif compte le plus : plus de courses, moins de kilomètres à vide, ou moins de temps de régulation ?
- [ ] Pouvez-vous exporter 2 à 4 semaines d'historique de courses (dates, adresses, horaires, type, prix) ?
- [ ] Quel budget et quel délai, et qui hébergera l'application (hébergeur HDS) ? Repères publics : 50 € HT par véhicule et par mois chez Ondy, environ 78 € HT chez Drivesoft pour 120 véhicules.

**Réglementation 2025-2027**

- [ ] Quelle part de vos courses est partagée aujourd'hui, en VSL et en taxi ? Comment prévenez-vous l'accueil des établissements ? (repères de la Cour des comptes : 21,7 % en VSL en 2024, environ 5 % en taxi)
- [ ] Les prescriptions reçues indiquent-elles la catégorie de soins et le motif de prise en charge ? Depuis le 1er octobre 2026, une ALD non exonérante ne suffit plus (décret 2026-812, à confirmer). (catégorie de soins : à saisir sur la prescription dans un prochain lot ; motif de prise en charge : reste dans le logiciel de facturation de V, pas dans Opti-Taxi)
- [ ] Taxis : la liste des conducteurs et des véhicules déclarés à la CPAM est-elle à jour ? Sur Équipages, faut-il bloquer un remplaçant non déclaré, dont les courses CPAM ne seraient pas remboursées (art. 5.1), ou seulement le signaler ? (bloqué pour une course CPAM en taxi conventionné, signalé seulement pour un client privé ; rien n'est contrôlé aujourd'hui)
- [ ] Taxis : combien d'ADS avez-vous, dans quelles communes, et quelle part des patients de chacune vient de son territoire ? Depuis le 1er novembre 2026, une ADS doit prendre en charge en majorité des patients de son territoire (art. 5.2, non revérifié). (rien n'est suivi : l'optimiseur affecte les taxis sans regarder le territoire)
- [ ] Accord préalable : quels longs trajets ou quelles séries en demandent un aujourd'hui (plus de 150 km, séries de plus de 50 km), et qui le suit ? (rien n'est suivi dans l'application)

**Exploitation**

- [ ] Que recouvrent vos termes : « ambulance » = VSL ? « taxi » = conventionné, privé, ou les deux ?
- [ ] Combien de véhicules par type, combien de chauffeurs, quels dépôts ? En partie répondu le 6 novembre : environ 120 véhicules, plusieurs dépôts dans différentes villes.
- [ ] Combien de courses par jour, et quelle part de patients réguliers ? En partie répondu le 6 novembre : environ 300 voyages (allers simples) par jour, à recouper avec « 2 courses par véhicule et par jour ».
- [ ] La limite de 2 patients par véhicule est-elle un choix de V ou une contrainte des véhicules ?
- [ ] Quelle tolérance d'horaire : combien de temps avant le RDV un patient accepte-t-il d'arriver ?
- [ ] Comment connaît-on l'heure de fin de séance pour organiser le retour ?
- [ ] Les chauffeurs ont-ils un smartphone professionnel ?

Ajoutées après l'appel du 6 novembre (entre parenthèses, l'hypothèse retenue en attendant) :

- [ ] Volume : 120 × 2 donne 240, pas 300 ; et si une « course » est un aller-retour, 480 voyages. Quel chiffre, et les 120 véhicules roulent-ils tous chaque jour ? (environ 300 allers simples par jour)
- [ ] « Accompagnants » : du personnel, ou des proches du patient qui prennent une place à bord ? (du personnel)
- [ ] « Cotation » : coût interne pour choisir le véhicule, ou prix annoncé au client ? (coût interne)
- [ ] Électrique : l'exemple Sisteron – Aix s'explique-t-il par l'autonomie, le coût, autre chose ? Où recharge-t-on ? (autonomie et coût, recharge au dépôt)
- [ ] Préférences et affinités : lesquelles sont impératives ? (paires de collègues interdites impératives, préférences patient souhaitables)
- [ ] « Déplacer vers… » : quand le nouveau calcul fait sortir une autre course du planning (l'optimiseur en place une autre à la place), faut-il refuser le déplacement ou demander confirmation en nommant les courses perdues ? (confirmation, en attendant l'insertion locale qui ne touchera pas aux autres tournées)
- [ ] Temps à bord : combien de minutes au plus en plus du trajet direct pour un patient transporté avec d'autres ? (30 min, réglable dans Paramètres ; sur le banc de 300 voyages, 30 min font passer le partage de 43 % à 38 % par rapport à une limite de 3 h)
- [ ] Quand tout ne tient pas : un patient conduit au centre sans retour prévu compte-t-il comme deux courses non servies ? (oui : laisser un aller ou un retour seul coûte une pénalité de plus, payée une fois par patient ; la priorité par type de soin reste à fixer)
- [ ] Pause de 20 min dès 6 h de travail (art. L. 3121-16) : les chauffeurs de V sont-ils salariés, artisans ou les deux, et quel accord s'applique (accord-cadre du 4 mai 2000 pour le transport sanitaire) ? Faut-il en plus interdire plus de 6 h de travail d'affilée avant la pause ? (une pause d'au moins 20 min dans toute tournée de plus de 6 h, où qu'elle tombe ; un horaire de plus de 6 h sans pause valable est bloqué sur Équipages)
- [ ] Temps d'arrêt : combien de minutes pour une prise en charge et une dépose en ambulance, pour un patient en fauteuil ou allongé, et quels établissements sont longs à desservir ? (5 min partout par défaut, comme avant ; le jeu de démonstration met 10 min en ambulance et 5 min de plus à l'hôpital des Calanques)

**Tarifs et facturation (lot tarifaire, 9 novembre 2026)**

Questions du mémo tarifaire ; entre parenthèses, la lecture retenue (Grilles tarifaires › Règles de facturation).

- [ ] Siège : département et commune du siège ? Avec des dépôts dans plusieurs départements, la zone VSL est-elle celle du siège ou celle de chaque établissement ? (siège à Marseille, 13 ; il décide aussi du forfait agglomération des ambulances)
- [ ] ADS : quel est le département de l'ADS de chaque taxi ? Est-ce bien le « département de rattachement » de la fiche véhicule ? (oui)
- [ ] TVA : le CA estimé doit-il être TTC ou HT ? Les tarifs VSL sont TTC avec 10 % de TVA, l'ambulance est exonérée, la TVA du taxi n'est pas connue. (TTC)
- [ ] Retour à vide en taxi : faut-il le compter ? Il concerne dialyse, chimiothérapie et radiothérapie, donc l'essentiel de la patientèle, mais récompense un trajet à vide. Quand un retour est-il « à vide », et avec quelle preuve ? (compté pour l'aller qui termine la tournée et le retour qui la commence)
- [ ] Retour à vide et majoration de 50 % : se multiplient-ils ou s'additionnent-ils ? (multipliés : 262,59 € au lieu de 238,08 € sur l'exemple T3)
- [ ] Abattement quand la composition change en route (A avec B, puis B avec C) : compte-t-on les patients distincts ou le plus grand nombre à bord en même temps ? (patients distincts)
- [ ] Taxi : le détour d'un patient en transport partagé est-il facturable ? (non : distance directe)
- [ ] Seuil local de l'abattement de 5 % (patient seul sur une longue distance) dans les CPAM 13, 84, 04, 05, 26 et 38 ? (30 km, minimum national)
- [ ] Supplément local de carence (SX1) : existe-t-il dans ces départements, et pour quel montant ? (aucun)
- [ ] Supplément taxi « courte distance » de 2 € depuis le 1er août 2026 : la CPAM le confirme-t-elle, et avec quels cumuls ? (non compté)
- [ ] Arrondis : km entiers ou décimaux, arrondi par ligne ou par facture ? À vérifier sur une facture SEFi ou B2 réelle de V. (km au mètre, facture au centime)
- [ ] Jours fériés retenus pour la majoration : seulement les fériés légaux ? (les 11 fériés légaux)
- [ ] VSL et ambulance : la majoration de nuit, de dimanche et de jour férié s'applique-t-elle au trajet court et au TPMR ? L'abattement de partage VSL porte-t-il sur les suppléments et les péages ? (trajet court majoré, TPMR et péages ni majorés ni abattus)
- [ ] « Forfait spécial » de l'agglomération de Grenoble en ambulance : montant et règle ? (forfait départemental)
- [ ] Ambulance pour un transport assis : quand l'autoriser, et avec quel code de facturation ? (proposée par le régulateur pour une course assise non affectée, facturée au tarif VSL, comptée au tableau de bord)
- [ ] VSL à 3 patients : faut-il relever la capacité des VSL de V ? (2 places ; la grille autorise 3)
- [ ] Péages et TPMR : V suit-il ses péages par course ? A-t-il des véhicules équipés TPMR ? (saisie possible par course ; un VSL équipé dans la démo)
- [ ] Un distancier local est-il négocié avec la CPAM (convention ambulance, art. 14) ? (distance routière d'OSRM, ou à vol d'oiseau sans OSRM)
- [ ] Échéances à suivre : décret de géolocalisation (au plus tard le 1er janvier 2027), étape du 1er juillet 2027 (tarif majoré réservé aux flux certifiés de niveau 3 à 5), avenant 12, recours des fédérations taxi contre l'arrêté du 29 juillet 2025, clause de revoyure taxi (31 mars), baisse éventuelle des tarifs ambulance et VSL en 2027.

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
- Équipage du jour : une personne absente (congé, garde…) n'est jamais planifiée, une paire interdite jamais réunie, une personne sur un seul véhicule par jour.
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

Textes officiels (vérifiés le 9 novembre 2026, détail et niveaux dans « Réglementation 2025-2027 ») :

- [Loi n° 2026-534 du 25 juin 2026](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000054309429) et [art. L. 322-5-3 du code de la sécurité sociale](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006742504)
- [Décret n° 2025-202 du 28 février 2025, art. R. 322-11-1 à R. 322-11-8 du code de la sécurité sociale](https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006073189/LEGISCTA000006173384/) ; texte paru au [JO du 1er mars 2025](https://www.fhf.fr/sites/default/files/2025-03/joe_20250301_0052_0015_0.pdf)
- [Arrêté du 29 juillet 2025 approuvant la convention-cadre des taxis conventionnés](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052060568) et [ameli, convention nationale type](https://www.ameli.fr/taxi-conventionne/textes-reference/convention-nationale-type)
- [Arrêté du 29 septembre 2025 approuvant le protocole des transporteurs sanitaires](https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000052304334)
- [Ameli, tarifs conventionnels des VSL](https://www.ameli.fr/transporteur-sanitaire/exercice-professionnel/facturation/tarifs/vsl-tarifs-conventionnels) et [avenant 11 à la convention des transporteurs sanitaires](https://circulaires.ameli.fr/sites/default/files/directives/CIR-TMP-Annexe%201%20-%20Avenant11_TS.pdf)
- [Service-Public, transport partagé (19 mars 2025)](https://www.service-public.gouv.fr/particuliers/actualites/A18110), [Service-Public, géolocalisation et facturation (30 juin 2026)](https://entreprendre.service-public.gouv.fr/actualites/A18978), [FHF, conditions du transport partagé](https://www.fhf.fr/expertises/finances/budget-eprd/conditions-de-mise-en-oeuvre-des-transports-partages-de-patients-0)
- [Cour des comptes, RALFSS 2026, chapitre VII](https://www.ccomptes.fr/sites/default/files/2026-05/20260527-RALFSS-2026-7-Transports-patients-a-la-charge-de-l-assurance-maladie.pdf)
- Non revérifiés le 9 novembre : [ameli, accord préalable de transport](https://www.ameli.fr/medecin/exercice-liberal/accord-prealable/accord-prealable-transport), [art. R. 322-10-5 du code de la sécurité sociale](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006749252), questions écrites [QE 17933](https://questions.assemblee-nationale.fr/q17/17-17933QE.htm) et [QE 18245](https://questions.assemblee-nationale.fr/q17/17-18245QE.htm) sur le décret 2026-812

Autres sources :

- [Hexaly, planification opérationnelle de tournées de véhicules sanitaires](https://www.hexaly.com/wp-content/uploads/2024/02/Operational-planning-of-medical-vehicle-routes.pdf)
- [PTV Logistics, SCR Informatiques et SCR'AMBGES (sept. 2025)](https://www.ptvlogistics.com/en-us/resources/news/products/scr-informatiques-certifies-medical-transport-using-ptv-developer)
- Offres France Travail citant [LOMACO](https://candidat.francetravail.fr/offres/recherche/detail/191MWYJ) et [SAPHIR](https://candidat.francetravail.fr/offres/recherche/detail/211ZHGB)
- Concurrence : sources numérotées en fin d'annexe.

Sources remplacées le 9 novembre 2026 : [WebLex (mai 2025)](https://www.weblex.fr/weblex-actualite/taxis-nouvelle-convention-cadre-avec-l-assurance-maladie) et [Maire-info (mai 2025)](https://www.maire-info.com/transport-sanitaire-des-milliers-de-taxis-manifestent-en-france-article2-29718), par la convention publiée ; [amendement AN n° 2098](https://www.assemblee-nationale.fr/dyn/16/amendements/1682/AN/2098.pdf), source de l'abattement erroné de « 15 à 35 % ».

## Annexe : fiches des concurrents (vérifiées le 9 novembre 2026)

Les numéros entre crochets renvoient aux sources en fin d'annexe. « Revendiqué » ou « annoncé » : affirmé par l'éditeur seulement.

### Saphir et EMMAI (Synovo Group)

- **Éditeur** : Synovo Group SAS, Strasbourg (SIREN 790 710 735), immatriculée le 25 février 2013 [1]. Filiale au Québec depuis 2022. Investissement de 12 M€ de Lauxera Capital Partners [2].
- **Positionnement** : Saphir est un ERP complet pour les sociétés d'ambulances (régulation, facturation, RH, flotte) [3]. EMMAI ajoute une IA « intégrée à Saphir » pour la planification J+1, la régulation en temps réel et le transport partagé. Formule : « l'algorithme prépare le terrain ; vos régulateurs décident » [4].
- **Prix** : sur devis, abonnement possible avec une durée minimale d'engagement [5]. Les outils transporteurs de Saphir Online Booking sont annoncés gratuits.
- **Clients revendiqués** (non vérifiés) : plus de 300 sociétés d'ambulances sur Saphir. Pour le groupe : plus de 1 500 clients, 8 200 véhicules, 120 000 transports par jour, 7 pays [3][6]. Aucun client d'EMMAI n'est nommé.
- **Faits marquants** :
  - EMMAI annonce 200 paramètres et −25 % de km, sans démo, sans temps de calcul et sans client nommé [4][7].
  - Le blog résume le décret 2025-202 sans dire que Saphir ou EMMAI contrôle le détour ou l'attente, ni qu'il trace le refus [8].
  - Côté hôpital, les commandes passées dans Rubis Santé arrivent dans Saphir sans ressaisie [9].
  - Rubis Exchange délègue une mission à un confrère choisi par un algorithme ; aucune source tierce ne le confirme [10].
- **Contradictions** : date de création donnée en 2008, 2012 ou 2013. Levée Lauxera datée de 2022 ou de juillet 2024. EMMAI est présenté tantôt comme un module de Saphir, tantôt comme un produit séparé : on ne sait pas s'il est payant en plus. Hébergement dans les data centers HDS de Synovo selon le site, « local ou cloud » selon lebonlogiciel [11]. Caree figure dans le pied de page de Synovo, mais ses mentions légales ne citent pas Synovo [12].

### Lomaco (Lomaco Online)

- **Éditeur** : Lomaco, raison sociale SOC LOCATION MATERIEL COMPTABLE (SAS, SIREN 661 650 218), Figeac, groupe Fideciel. Créée en 1967. CA 2025 : 23,95 M€. Effectif de 50 à 99 salariés [13].
- **Positionnement** : ERP historique pour ambulances, VSL et taxis conventionnés : régulation, facturation et télétransmission, gestion du temps, appli mobile, géolocalisation (Exdat). L'éditeur annonce un algorithme qui planifie seul les courses du lendemain [14].
- **Prix** : seul prix public, pour le taxi conventionné : de 1,50 € HT par facture (factures 1 à 10) à 0,20 € HT dès la 51e, plus 100 € HT de mise en place. Forfait, SEFi et Planning sur devis [15]. Aucun prix pour l'ambulance ni le VSL.
- **Clients revendiqués** : selon le GIE SESAM-Vitale (2023), le groupe Fideciel est l'acteur majeur du transport sanitaire et le leader chez les taxis conventionnés [16]. La plateforme SPS revendiquait en 2021 plus de 30 000 courses par mois et 1 200 transporteurs [17]. Le site liste une instance à Grenoble.
- **Faits marquants** :
  - La planification automatique est dite « en production en 2021 ». L'éditeur la rattache à une thèse de Mines Saint-Étienne qui ne nomme pas Lomaco. Aucune démo ni aucun résultat publics [14][18].
  - Le transport partagé se limite à des « simultanés » créés par glisser-déposer et à une « aide aux simultanés ». Rien sur le décret 2025-202.
  - L'appli chauffeur Android est notée 2,9/5 sur 46 avis (batterie vidée, réglages perdus). Elle n'a pas été trouvée sur l'App Store français [19].
  - SPS est gratuite pour les établissements et payée par les transporteurs, environ 0,50 € par trajet en 2021 [17].
- **Contradictions** : « depuis 1966 » sur le site, création au 1er janvier 1967 au registre. L'option « SEFI Taxi » est encore vendue, alors que le SEFi Taxis est fermé depuis le 1er octobre 2025 (décision de la Commission des téléservices du 16 mars 2026) [20]. Le logiciel est dit « full web », mais le descriptif technique exige Windows 10 et Chrome [21]. Le catalogue SESAM-Vitale cite Lomaco Online en SEFi 03.50, alors qu'aucune certification n'a été trouvée sur les pages Lomaco : à revérifier [22].

### SCR'AMBGES (SCR Informatiques)

- **Éditeur** : SCR Informatiques SAS, Erbray (Loire-Atlantique), SIREN 432 559 904 [23]. Création revendiquée en 1990 ; l'entité actuelle est immatriculée depuis 2000. La présidence est passée du fondateur Frédéric Nunge à SAPEMO FINANCES le 22 août 2026. La société sœur LCR-I édite la plateforme hospitalière LCR_i.
- **Positionnement** : ERP installé pour ambulanciers (SCR'AMBGES) et taxis (SCR'TAXIGES), complété par SCR'Urgences pour le SAMU et LCR_i pour les hôpitaux. Promesse : tout dans un seul logiciel, avec facturation certifiée, régulation, RH et paie, appli PDA et géolocalisation [24]. Aucune capacité n'est vérifiée hors des pages de l'éditeur et de son partenaire PTV.
- **Prix** : aucun tarif publié, modules sur devis, « aucun contrat d'engagement » [25]. Seul chiffre public, pour un autre produit : 50 000 € en 2012 pour SCR'Urgences en Loire-Atlantique, 110 véhicules [26].
- **Clients revendiqués** : plus de 1 000 entreprises de transport sanitaire, et environ 5 000 VSL et taxis facturés au kilomètre réel [27]. LCR_i : 120 établissements et 25 groupements [28].
- **Faits marquants** :
  - Un communiqué PTV/SCR de septembre 2025 annonce la recherche de patients regroupables et le calcul du détour, pour atteindre le quota de 5 %. Rien sur l'attente ni sur le refus [27].
  - Aucune méthode n'est décrite pour l'« optimisation du planning » ; PTV ne cite que des API de géocodage, d'itinéraire et de carte [29].
  - Certification SEFi depuis 2015 et géolocalisation avenant 11 revendiquées, non confirmées par les listes officielles consultées [30].
  - LCR_i revendique 3 groupements et 12 centres hospitaliers en Isère, sur l'axe Grenoble [28].
- **Contradictions** : 1 000 entreprises, 2 000 entreprises ou « 2 000 clients quotidiens » selon la page. SARL dans les mentions légales, SAS au registre depuis 2021. Transport partagé annoncé par PTV, absent des pages produit. La nature de SAPEMO FINANCES (holding ou acquéreur) est inconnue.

### Drivesoft

- **Éditeur** : DRIVESOFT SAS, Paris 8e (SIREN 939 820 791), immatriculée le 16 janvier 2025. Elle est présidée par la holding BRX Software & Invest (Florent Breux) [31]. Lancement public le 19 octobre 2026 [32].
- **Positionnement** : suite tout-en-un pour taxis conventionnés, ambulances, VSL et sociétés mixtes : régulation, appli chauffeur, facturation Ameli, personnel, parc, stocks, QHSE. Promesse : « Un logiciel. Pas quatre. » [33]
- **Prix** : public, HT par véhicule et par mois, dégressif, sans engagement : de 60 € (Standard) à 95 € (Premium) [34]. Pour 120 véhicules, seule la formule Premium est possible : 9 375 € HT par mois, soit environ 78 € par véhicule. Le GPS Trakeo coûte en plus 12,90 € HT par véhicule et par mois, avec 36 mois d'engagement.
- **Clients revendiqués** : aucun client nommé. Offre fondateur pour les 15 premières sociétés. Plus de 50 téléchargements sur Google Play [35].
- **Faits marquants** :
  - Labels du catalogue SESAM-Vitale : PEC+ (janvier 2026), chiffrement de flux (août 2026), GEO et SEFi (1er octobre 2026), pour le transport sanitaire seulement [22].
  - L'optimisation des tournées n'est qu'une ligne du Copilot IA Premium, sans méthode ni gains [33].
  - Rien sur le transport partagé ni sur le décret 2025-202.
  - L'appli chauffeur a un mode hors ligne avec synchronisation, les signatures et les photos [35].
- **Contradictions** : « SEFi 3.50 » sur les plaquettes, 03.40 au catalogue [36]. « SEFi inclus dès Standard », alors que le label ne couvre pas le taxi. Travail revendiqué « depuis 2020 » pour une société immatriculée en 2025. Siège à Paris, mais adresse à Herblay au catalogue. Les mentions légales nomment AWS Paris comme hébergeur, mais la politique de confidentialité n'a que des titres de sections, sans texte [37].

### Ondy (ex-Heroad)

- **Éditeur** : ONDY SAS, Marseille 9e (SIREN 944 842 970), créée le 24 mai 2025 [38]. Le produit reprend Heroad (HEROAD SAS, Bordeaux, 2021) : heroad.io redirige vers ondy.fr, l'appli Android garde l'identifiant com.heroad.io et le vendeur App Store reste « Heroad, Bordeaux » [39][40]. Homonyme écarté : Ondy Inc. (New Jersey).
- **Positionnement** : artisans taxis conventionnés et petites sociétés de taxis, surtout dans les Bouches-du-Rhône et en Martinique. Promesse : « si vous savez utiliser WhatsApp, vous savez utiliser Ondy », avec agenda gratuit, partage de courses entre confrères et facturation CPAM dite certifiée B2 [41].
- **Prix** : agenda gratuit. Formule Artisan à 30 € HT par mois, formule Société à 50 € HT par mois et par véhicule, −20 % en annuel. SMS à 0,07 € HT l'envoi, boîtier de géolocalisation à 100 € HT [42]. Pour 120 véhicules : environ 6 000 € HT par mois, 4 800 € HT en annuel.
- **Clients revendiqués** (non vérifiés) : 96 ou 119 sociétés dans les Bouches-du-Rhône selon l'endroit de la page, 48 en Martinique [41]. Plus de 100 téléchargements Android, 7 notes sur l'App Store [39][40].
- **Faits marquants** :
  - Le cœur du produit : confier une course à un confrère, même sans compte, par un lien, avec les documents du transport et une trace [39].
  - Aucune optimisation automatique : l'affectation est manuelle [43].
  - Taxi seulement : rien pour l'ambulance ni le VSL.
  - Hébergement chez Supabase, « en France », sans certification HDS. Google Play indique « Les données ne sont pas chiffrées » [44].
- **Contradictions** : vendeur différent selon le store, et ni raison sociale ni adresse dans les CGV. Note de 4,8 sur 127 avis déclarée par le site, contre 4,4 sur 7 notes sur l'App Store. SEFi annoncé sur Google Play, pas sur le site. Données de santé collectées selon la politique de confidentialité, « aucune donnée » selon l'App Store.

### SanteMobile

- **Éditeur** : SANTE MOBILE SAS (SIREN 104 072 459), créée le 17 avril 2026, siège à Manneville-sur-Risle (Eure), président Aurélien Boulet [45]. Santé Mobilité Services (Bouc-Bel-Air) porte un nom proche, sans lien établi.
- **Positionnement** : régulation et dispatch pour petites sociétés d'ambulances, de VSL et de TPMR (3 à 20 véhicules, surtout en Normandie), avec un tableau de bord régulateur, une app équipage et une app patient. Il se place en amont du logiciel de facturation et ne vise pas les taxis conventionnés [25].
- **Prix** : gratuit pendant la bêta (30 places). Ensuite, un forfait mensuel au montant non publié [46].
- **Clients revendiqués** : 11 sociétés inscrites à la bêta, aucun client nommé [46].
- **Faits marquants** :
  - Un « moteur de plan du jour » propose la journée selon 4 méthodes. Les propositions s'affichent en pointillés et ne s'appliquent qu'après validation [47].
  - Il annonce des paires de patients assis sous les plafonds de détour et d'attente du décret 2025-202, sans trace du refus de partage [47].
  - L'éditeur écrit ce qu'il ne fait pas : facturation, SEFi, géolocalisation certifiée, HDS, contrôle de l'amplitude et du repos [25][48][49].
  - L'app patient montre le véhicule sur une carte, l'heure d'arrivée et le retard [50].
- **Contradictions** : transport partagé livré selon certaines pages, absent de la page produit principale. « Basée à Rouen », siège dans l'Eure. « Aucune donnée médicale », mais fauteuil roulant et oxygène sont demandés au patient. « Données hébergées en France », mais Google Maps (États-Unis) sert de secours pour les adresses et les itinéraires [51]. CGU datées d'avant la création de la société.

### Amblea

- **Éditeur** : Amblea SAS, Paris 8e (SIREN 840 859 300). Elle est née de la fusion d'Ambler (2018) et de Sanilea (2013), annoncée en juin 2023. Investisseurs : Partech, Eurazeo, Bpifrance, Extens. CA 2025 : 3,06 M€, résultat net : −0,88 M€ [52][53].
- **Positionnement** : plateforme où les établissements (GHT, hôpitaux, cliniques, EHPAD, centres de dialyse) commandent leurs transports. Des régulateurs Amblea les répartissent vers un réseau d'ambulanciers et de taxis conventionnés [54]. Ce n'est pas un logiciel de planification de flotte : c'est un canal d'entrée de courses et un concurrent partiel sur le regroupement de patients.
- **Prix** : aucun prix publié. Appli transporteur gratuite. Modèle économique non public.
- **Clients revendiqués** : selon le site, plus de 800 établissements, 6 300 transporteurs et 8 000 trajets par jour ; logos dont APHM, ELSAN et Emeis [54].
- **Faits marquants** :
  - La presse confirme la commande en ligne par les établissements, avec PMT préremplies et séries ALD [55].
  - L'appli détecte des regroupements selon le détour et la rentabilité, et propose des enchaînements après une mission acceptée. Elle n'optimise pas la journée d'un véhicule [56].
  - Le site annonce des duos ou trios, un détour et une attente maximum, et un gain minimal garanti au transporteur. Il ne cite pas le décret et ne trace pas le refus [54].
  - L'appli transporteur est notée 2,1/5 sur Google Play (23 avis) : déconnexions, peu de missions [56].
- **Contradictions** : près de 900 établissements annoncés en 2023, « 800+ » aujourd'hui [53]. Société à mission selon le site, mais pas selon l'API du registre [52]. « Aucune donnée collectée » sur l'App Store, alors que l'appli donne accès aux PMT [57]. Le chiffre de 80 % désignait une économie en 2023 ; il désigne aujourd'hui une part de transports partagés.

### Becose

- **Éditeur** : Becose est une marque ; aucune société ne porte ce nom. L'éditeur déclaré au CNDA est TAXI STRASBOURG, une société de taxi (deux SARL à la même adresse, SIREN 803 761 014 et 903 603 322) [58]. Le site est signé par l'agence Geekeur, à la même adresse. Le lien entre le site et l'éditeur repose sur le même téléphone et la même adresse.
- **Positionnement** : facturation CPAM pour taxis conventionnés, VSL et ambulances, avec appli chauffeur et portail pour les établissements, surtout pour les petites flottes. Promesse : « Facturez vos courses depuis la voiture. Sans rejet. » Produit non lancé : bêta gratuite annoncée pour janvier 2027 [59].
- **Prix** : tarif « cible » de 30 à 80 € HT par véhicule et par mois, −50 % à vie pour les 200 premiers inscrits. Ni grille définitive, ni CGV [59].
- **Clients revendiqués** : aucun. Trois avis anonymes de prospects, au conditionnel.
- **Faits marquants** :
  - Seule conformité vérifiée : PEC+ au CNDA depuis le 28 janvier 2026 (BECOSE 1.0.9) [58].
  - « SEFi natif » est affiché, alors que la liste du CNDA ne montre que PEC+. La géolocalisation repose sur le GPS du téléphone [60].
  - Le site annonce une affectation automatique « selon 7 critères » et un regroupement de patients avec « respect des règles CPAM », sans citer le décret 2025-202 [61].
  - Aucune appli trouvée sur l'App Store français ni sur Google Play.
- **Contradictions** : « l'agrément CNDA est en cours » sur une page, « télétransmission B2/CNDA intégrée » sur l'accueil. Le produit est dit à la fois « 100 % web » et « app native ». Gains chiffrés (−95 % de rejets CPAM) sans aucun client. Fondation en 2026 selon le site, mais une page « bientôt » existait dès 2021 [62]. Pas de mentions légales : la page renvoie une erreur 404.

### Sources des fiches

1. https://www.societe.com/societe/synovo-group-790710735.html
2. https://lauxera.com/synovo-group
3. https://www.synovo-group.com/solutions/saphir
4. https://www.synovo-group.com/solutions/emmai
5. https://www.synovo-group.com/cgv
6. https://www.synovo-group.com/en/qui-sommes-nous
7. https://www.decideurs-magazine.com/innovation-sante/61351-l-intelligence-artificielle-au-coeur-de-la-sante-de-demain.html
8. https://www.synovo-group.com/blog/transport-partage-patients-objectifs-2027
9. https://www.hospitalia.fr/Rubis-Sante-une-solution-pour-faciliter-les-transports-sanitaires-et-le-brancardage-a-l-hopital_a4494.html
10. https://www.synovo-group.com/solutions/exchange
11. https://lebonlogiciel.com/organisation-facturation-et-planification-gestion-commerciale-erp-gpao/saphir/2118
12. https://www.caree.fr/mentions-legales
13. https://recherche-entreprises.api.gouv.fr/search?q=661650218
14. https://lomaco.fr/transport-sanitaire/logiciel-regulation/
15. https://lomaco.fr/transport-sanitaire/taxi-conventionne/
16. https://sesam-vitale.fr/documents/d/sesam-vitale/etude_de_marche_2023_des_entreprises_du_numerique_en_sante
17. https://www.hospitalia.fr/SPS-une-plateforme-gratuite-pour-les-etablissements-de-sante_a2737.html
18. https://theses.fr/api/v1/theses/these/2021LYSEM022
19. https://play.google.com/store/apps/details?id=com.lomaco.neithweb
20. https://www.sesam-vitale.fr/documents/20182/55478/htm-decisions-commission-teleservices-AM.pdf
21. https://lomaco.fr/fiches/descriptif-technique-lomaco-online-ambulance.pdf
22. https://www.sesam-vitale.fr/web/sesam-vitale/catalogue-produits-tpt?se=Service%20Electronique%20Facturation%20(SEFi)
23. https://www.societe.com/societe/scr-informatiques-432559904.html
24. https://www.scrinfo.net/solutions-scr/ambulancier/
25. https://santemobile.io/comparatif-logiciels-ambulance
26. https://www.lemondeinformatique.fr/actualites/lire-ambulances-geolocalisees-pour-gagner-en-efficacite-en-loire-atlantique-48818.html
27. https://www.ptvlogistics.com/fr/resources/news/products/scr-informatiques-certifie-le-transport-sanitaire-en-sappuyant-sur-ptv
28. https://lcri.fr/lcr-i-les-groupements/
29. https://www.ptvlogistics.com/fr/a-propos/nos-clients/scr-informatiques
30. https://www.scrinfo.net/nos-certifications/
31. https://annuaire-entreprises.data.gouv.fr/entreprise/939820791
32. https://drivesoft.fr/blog/lancement-drivesoft-logiciel-taxi-ambulance-vsl
33. https://drivesoft.fr/
34. https://drivesoft.fr/tarifs
35. https://play.google.com/store/apps/details?id=com.drivesoft
36. https://www.drivesoft.fr/guides/drivesoft-plaquette.pdf
37. https://drivesoft.fr/mentions-legales
38. https://recherche-entreprises.api.gouv.fr/search?q=ondy
39. https://play.google.com/store/apps/details?id=com.heroad.io&hl=fr&gl=FR
40. https://apps.apple.com/fr/app/ondy/id6747112126
41. https://ondy.fr/
42. https://ondy.fr/cgv
43. https://ondy.fr/gestion-planning-taxi
44. https://ondy.fr/confidentialite
45. https://recherche-entreprises.api.gouv.fr/search?q=104072459
46. https://santemobile.io/beta
47. https://santemobile.io/saas
48. https://santemobile.io/roadmap
49. https://santemobile.io/blog/planning-ambulancier-logiciel
50. https://apps.apple.com/fr/app/santemobile/id6776588301
51. https://santemobile.io/confidentialite
52. https://recherche-entreprises.api.gouv.fr/search?q=840859300
53. https://www.maddyness.com/?p=1357754
54. https://www.amblea.fr/es
55. https://www.ticsante.com/story?ID=6807
56. https://play.google.com/store/apps/details?id=fr.amblea.amblea&hl=fr&gl=FR
57. https://apps.apple.com/fr/app/amblea/id6476218574
58. https://cnda.ameli.fr/logiciels-certifies/?page_id=606&liste=2&idSecteur=1&idTable=5&idNum=9069
59. https://becose.fr/
60. https://becose.fr/teletransmission-cpam-sefi.html
61. https://becose.fr/logiciel-vsl.html
62. https://web.archive.org/web/20210302215215/http://www.becose.fr/
