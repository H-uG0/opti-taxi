# Contrat web ↔ optimizer (v1)

Le service `services/optimizer` expose trois routes HTTP JSON :

| Route | Corps | Réponse | Rôle |
| --- | --- | --- | --- |
| `GET /health` | — | `{"status":"ok","matrixSource":"osrm"\|"haversine"}` | sonde |
| `POST /optimize` | `OptimizeRequest` | `PlanResponse` | calcule les tournées d'une journée |
| `POST /evaluate` | `EvaluateRequest` | `PlanResponse` | recalcule horaires, km, CA et violations d'un planning donné (ajustement manuel) |

Implémentations : `apps/web/src/lib/optimizer/contract.ts` (zod) et
`services/optimizer/app/schemas.py` (pydantic). Les fichiers de `fixtures/` doivent être acceptés
par les deux ; un test de chaque côté le vérifie. Toute évolution modifie les trois à la fois.

Les noms de champs sont en camelCase des deux côtés du fil (pydantic : `alias_generator=to_camel`).

## Authentification et limites

- **Jeton** : quand `OPTIMIZER_TOKEN` est défini sur le service, `POST /optimize` et `POST /evaluate`
  exigent l'en-tête `Authorization: Bearer <OPTIMIZER_TOKEN>` (comparaison en temps constant) et
  répondent `401` sans lui ou avec un autre jeton. `GET /health` reste libre. Le web envoie l'en-tête
  dès que sa propre variable `OPTIMIZER_TOKEN` est définie (même valeur des deux côtés). Sans jeton
  configuré, le service accepte tout appel et le signale au démarrage (développement seulement).
- **Calculs simultanés** : `POST /optimize` répond `429` (en-tête `Retry-After: 30`) quand
  `OPTIMIZER_MAX_CONCURRENT_SOLVES` calculs (2 par défaut) tournent déjà. `/evaluate`, sans solveur,
  n'est pas compté.
- **Taille** : un corps de plus de `OPTIMIZER_MAX_BODY_MB` Mo (10 par défaut) reçoit `413` avant
  d'être lu. Une requête porte au plus 300 véhicules (`vehicles`, et `routes` pour `/evaluate`),
  3 000 courses (`trips`) et 500 grilles (`tariffs`) ; au-delà, `422`.

## Unités

- Heures : **entiers, minutes depuis minuit, heure locale Europe/Paris** de la date planifiée (`450` = 07:30).
- Distances : km (float). Montants : euros (float). Taux : fraction (0.23 = 23 %).
- Coordonnées : WGS84, `{ "lat": 43.29, "lng": 5.37 }`.

## OptimizeRequest

```jsonc
{
  "date": "2026-11-03",                 // YYYY-MM-DD, informatif
  "settings": {
    "waitBeforeAppointmentMin": 30,     // aller : arrivée au plus tôt RDV - 30, au plus tard RDV
    "waitAfterSessionMin": 15,          // retour : prise en charge entre fin de séance et +15
    "maxTotalWaitMin": 45,              // attente cumulée aller + retour d'un patient le même jour
    "maxDetourKmPerExtraPatient": 10,   // détour autorisé par co-passager distinct
    "maxDetourKmTotal": 30,             // plafond du détour d'un patient
    "pickupServiceMin": 5,              // temps d'arrêt à une prise en charge (course sans le sien)
    "dropoffServiceMin": 5,             // temps d'arrêt à une dépose (course sans le sien)
    "unassignedPenalty": 10000,         // € de pénalité par course non affectée
    "timeLimitSec": 10,                 // budget de calcul du solveur, entier 1..600 s (voir plus bas)
    "maxRideExtraMin": 30,              // facultatif (30 par défaut), 0..180 : temps à bord <= trajet direct + 30 min
    "traffic": {                        // facultatif, absent ou null = temps de trajet sans trafic (voir plus bas)
      "bands": [{ "startMin": 420, "endMin": 570 }, { "startMin": 570, "endMin": 960 }],
      "roadFactors": [1.05, 1],         // un facteur par créneau, hors des zones
      "zones": [{ "lat": 43.2965, "lng": 5.3698, "radiusKm": 14, "factors": [1.5, 1.2] }]
    }
  },
  "vehicles": [{
    "id": "veh_taxi_1",
    "label": "Taxi 1 (Marseille)",
    "type": "TAXI",                     // TAXI | VSL | AMBULANCE
    "capacity": 2,                      // patients simultanés (AMBULANCE : 1)
    "depot": { "lat": 43.2965, "lng": 5.3698 },
    "department": "13",                 // sélectionne la grille tarifaire
    "costPerKm": 0.32,                  // € / km (carburant, entretien)
    "costPerHour": 24,                  // € / h de service (chauffeur, équipage)
    "shiftStartMin": 360,               // départ du dépôt au plus tôt
    "shiftEndMin": 1140,                // retour au dépôt au plus tard
    "break": { "windowStartMin": 690, "windowEndMin": 840, "durationMin": 45 } // ou null ; sans pause
                                        // d'au moins 20 min dans l'horaire, une tournée dure 6 h au plus (art. L. 3121-16)
  }],
  "trips": [{
    "id": "trip_1",
    "patientId": "pat_1",               // relie aller et retour pour l'attente cumulée
    "facilityId": "fac_1",              // ou null (course privée)
    "direction": "OUTBOUND",            // OUTBOUND (domicile -> soins) | RETURN (soins -> domicile)
    "pickup":  { "lat": 43.30, "lng": 5.40 },
    "dropoff": { "lat": 43.28, "lng": 5.38 },
    "appointmentMin": 450,              // obligatoire si OUTBOUND, null sinon
    "readyMin": null,                   // obligatoire si RETURN (fin de séance), null sinon
    "allowedVehicleTypes": ["TAXI", "VSL"],
    "shareable": true,                  // prescription compatible ET patient non opposé
    "lockedVehicleId": null,            // course figée sur ce véhicule par le régulateur
    "pickupServiceMin": 10,             // facultatifs, 0..120 : temps d'arrêt propres à la course
    "dropoffServiceMin": 10             //   (absents ou null : ceux de settings)
  }],
  "tariffs": [{
    "vehicleType": "TAXI",
    "department": "13",                 // "*" = toutes les zones (repli si pas de grille exacte)
    "baseFare": 13,                     // forfait de prise en charge
    "pricePerKm": 1.12,
    "includedKm": 0,                    // km compris dans le forfait
    "sharedDiscount2": 0.23,            // abattement à 2 patients partagés
    "sharedDiscount3": 0.35             // abattement à 3 patients ou plus
  }],
  "initialRoutes": [{                   // facultatif, absent ou null = aucun : le planning en place (voir plus bas)
    "vehicleId": "veh_taxi_1",
    "stops": [{ "tripId": "trip_1", "kind": "PICKUP" }, { "tripId": "trip_1", "kind": "DROPOFF" }]
  }]
}
```

### Planning en place (`initialRoutes`)

Quand la date a déjà des tournées, le web les envoie (`routesInPlace`,
`apps/web/src/lib/planning/plan-compare.ts`) : la suite des arrêts de chaque tournée, dans l'ordre,
limitée aux véhicules et aux courses de la requête, une course prise puis déposée sur une même
tournée (même forme que `routes` de `/evaluate`, au plus 300 tournées). L'optimizer :

1. le **répare** selon les règles de la requête : il ignore un véhicule ou une course inconnus, une
   course d'un type de véhicule non autorisé ou figée sur un autre véhicule, une dépose avant sa
   prise en charge, une course déjà vue sur une autre tournée ; il retire de chaque tournée les
   courses en trop pour les places ou à bord d'un transport exclusif, celles qui dépassent leur
   détour, leur temps à bord ou leur attente au lieu de soins, puis, tant que la tournée n'est pas à
   l'heure, la course du premier arrêt en retard (la dernière si la tournée finit après l'horaire
   ou dure plus de 6 h sans pause) ; il place la pause ; il réinsère enfin là où elles tiennent les
   courses retirées et celles que le planning ne servait pas ;
2. s'en sert comme **point de départ** de la recherche, avec ses propres départs ;
3. ne renvoie **jamais un planning moins bon** que ce planning réparé : moins de courses non
   affectées, puis moins de patients dont l'aller et le retour ne sont pas servis tous les deux
   (pénalité de non-affectation chacun), puis meilleure marge (abattement de partage compris).

Réoptimiser une date où rien n'a changé rend donc un planning au moins aussi bon que celui en
place. Le champ n'entre pas dans l'empreinte de la requête qu'enregistre le web pour un calcul en
attente de confirmation (`requestHash`) : la version du planning en place le couvre déjà.

### Budget de calcul envoyé par le web (`settings.timeLimitSec`)

Le contrat accepte tout entier de 1 à 600. Le web envoie
`min(600, max(AppSettings.solverTimeLimitSec, ceil(trips.length / 8)))`, où `trips` est la liste
des courses envoyées (`effectiveTimeLimitSec` dans `apps/web/src/lib/optimizer/build-request.ts`) :
le réglage de /parametres (1 à 120 s), relevé à 1 s par tranche de 8 courses pour qu'une grosse
journée ne soit pas coupée court.

Ce budget comprend la construction du modèle par l'optimizer (depuis le 7 novembre 2026) : à
120 véhicules, elle prend 13 s pour 300 courses, 28 s pour 480, que la marge du web (budget + 30 s)
ne pouvait pas absorber en plus. Le calcul de la matrice reste en dehors.

### Trafic (`settings.traffic`)

Les temps de `matrixSource` sont à circulation fluide. Avec `traffic`, l'optimizer calcule une table
de temps par créneau (`bands`, triés et sans chevauchement ; hors créneau : circulation fluide) :

`temps = base + Σ zones minutes_dans_la_zone × (facteur_zone - 1) + reste × (roadFactor - 1)`, arrondi
à la minute supérieure, avec `minutes_dans_la_zone` = longueur du segment droit dans le cercle de la
zone, × 1,3, à 30 km/h, plafonnée à `base`. Un facteur vaut de 1 à 5.

Le temps d'un trajet dépend des **minutes de référence** de ses deux extrémités, connues avant le
calcul et identiques pour le solveur, la planification et le validateur : il prend le plus lent des
créneaux de ces deux minutes, car un long trajet parti avant la pointe la traverse en arrivant. Aller :
rendez-vous à la dépose, rendez-vous moins le trajet direct fluide à la prise en charge. Retour : fin de
séance à la prise en charge, fin de séance plus le trajet direct fluide à la dépose. Pause : milieu de sa
fenêtre. Dépôt : pas de référence, l'autre extrémité plus ou moins le trajet fluide.

`meta.trafficSource` dit ce qui a été appliqué : `none` ou `factors`. Une API de trafic (temps par
créneau demandés à un fournisseur) serait une autre valeur, sans changer le reste du contrat.

### Temps d'arrêt par course (`trips[].pickupServiceMin`, `trips[].dropoffServiceMin`)

Le web les calcule (`tripServiceMinutes`, `apps/web/src/lib/optimizer/build-request.ts`) : temps du mode
de transport (ambulance, ou taxi et VSL pour une course assise, qui peut partir dans l'un ou l'autre),
plus la majoration de la mobilité du patient (fauteuil, allongé) aux deux arrêts, plus celle de
l'établissement à l'arrêt chez lui (dépose d'un aller, prise en charge d'un retour). Il ne les envoie
que s'ils diffèrent de `settings.pickupServiceMin` / `dropoffServiceMin` : sans ces réglages, la
requête est la même qu'avant. Le solveur, le calcul des horaires et le validateur les utilisent
(`departureMin = startMin + temps d'arrêt`).

### Fenêtres horaires dérivées (calculées par l'optimizer, une seule source de vérité)

- `OUTBOUND` : la dépose (arrivée du patient au lieu de soins) commence dans
  `[appointmentMin - waitBeforeAppointmentMin, appointmentMin]`. Prise en charge : libre.
- `RETURN` : la prise en charge au lieu de soins commence dans
  `[readyMin, readyMin + waitAfterSessionMin]`. Dépose : libre.
- Si `waitBeforeAppointmentMin + waitAfterSessionMin` dépasse `maxTotalWaitMin`, les fenêtres de
  l'aller et du retour d'un même patient sont resserrées (la marge avant le RDV d'abord) ; une
  course sans son aller ou son retour attend au plus `maxTotalWaitMin`.

### Attente à bord au lieu de soins et temps à bord

Le véhicule peut rester arrêté devant le lieu de soins avec un patient à bord : il attend
l'heure d'un autre patient (retour partagé : A prêt à 11:00, pris à 11:15, B prêt à 11:30), ou
l'ouverture de la fenêtre de dépose. Ces minutes d'attente à bord (`startMin - arrivalMin` des
arrêts au même endroit, patient à bord) comptent dans l'attente du patient au lieu de soins :
l'aller avant sa dépose, le retour après sa prise en charge. Le temps d'arrêt des autres patients
(leur montée, leur descente) n'en fait pas partie. L'optimizer garde chaque trajet dans sa fenêtre,
attente à bord comprise ; le validateur vérifie le total (`TOTAL_WAIT`).

Temps à bord : de la fin de la prise en charge (`departureMin`) au début de la dépose
(`startMin`), au plus le trajet direct (aux minutes de référence de la course, voir « Trafic ») +
`maxRideExtraMin` (`RIDE_TIME`).

## EvaluateRequest

Les champs de `OptimizeRequest` (sauf `initialRoutes`, refusé ici) + le planning à évaluer, arrêt par
arrêt (sans horaires : l'optimizer les recalcule au plus tôt) :

```jsonc
{
  "...": "tous les champs de OptimizeRequest sauf initialRoutes",
  "routes": [{
    "vehicleId": "veh_taxi_1",
    "stops": [{ "tripId": "trip_1", "kind": "PICKUP" }, { "tripId": "trip_1", "kind": "DROPOFF" }]
  }]
}
```

Les courses absentes de `routes` sont non affectées.

## PlanResponse

```jsonc
{
  "status": "OK",                       // OK | NO_SOLUTION (aucune solution trouvée dans le temps imparti)
  "routes": [{
    "vehicleId": "veh_taxi_1",
    "startMin": 395, "endMin": 600,     // départ / retour au dépôt
    "distanceKm": 41.3,
    "emptyKm": 12.1,                    // km roulés sans aucun patient à bord (dépôt inclus)
    "loadedKm": 29.2,
    "durationMin": 205,                 // endMin - startMin
    "revenue": 96.4,                    // somme du CA estimé des courses de la tournée
    "cost": 95.2,                       // distanceKm * costPerKm + durationMin / 60 * costPerHour
    "margin": 1.2,
    "break": { "startMin": 700, "endMin": 745 },   // ou null
    "stops": [{
      "tripId": "trip_1", "kind": "PICKUP",
      "location": { "lat": 43.30, "lng": 5.40 },
      "arrivalMin": 410,                // arrivée du véhicule
      "startMin": 410,                  // début du service (après attente éventuelle de la fenêtre)
      "departureMin": 415,              // startMin + temps d'arrêt
      "loadAfter": 1                    // patients à bord après l'arrêt
    }]
  }],
  "trips": [{
    "tripId": "trip_1",
    "vehicleId": "veh_taxi_1",          // null si non affectée
    "pickupMin": 410, "dropoffMin": 440,// début de service des deux arrêts, null si non affectée
    "shared": true,                     // au moins un co-passager pendant le trajet
    "coPassengerTripIds": ["trip_7"],
    "directKm": 18.2,                   // distance directe prise en charge -> dépose (base du CA)
    "rideKm": 24.0,                     // distance réellement parcourue patient à bord
    "detourKm": 5.8,                    // rideKm - directKm
    "revenue": 31.6,                    // CA estimé de la course (abattement inclus), 0 si non affectée
    "waitAtFacilityMin": 10             // aller : RDV - début de la dépose ; retour : prise en charge - fin de séance
                                        // (sans l'attente à bord, comptée par TOTAL_WAIT)
  }],
  "unassigned": [{ "tripId": "trip_9", "reason": "Aucun véhicule compatible disponible" }],
  "kpis": {
    "tripsTotal": 60, "tripsServed": 58, "tripsUnassigned": 2,
    "vehiclesUsed": 9, "tripsPerVehicle": 6.44,
    "totalKm": 1520.4, "emptyKm": 498.1, "emptyKmRatio": 0.3276,
    "sharedTrips": 14, "sharedTripRatio": 0.2414,     // parmi les courses servies
    "revenue": 3120.5, "cost": 1610.2, "margin": 1510.3
  },
  "validation": {
    "valid": true,                      // aucune violation de contrainte dure
    "violations": [{ "code": "TIME_WINDOW", "message": "…", "tripId": "trip_3", "vehicleId": "veh_vsl_2" }]
  },
  "meta": {
    "matrixSource": "haversine",        // osrm | haversine
    "trafficSource": "factors",         // none | factors (voir « Trafic »)
    "solverStatus": "ROUTING_SUCCESS",  // libellé du solveur ; "INSERTION" : planning de l'insertion
                                        // Python seule (grande journée) ; "EVALUATE" pour /evaluate
    "objective": 123456,                // valeur interne du solveur (centimes), null pour /evaluate
    "wallTimeMs": 2140,
    "warnings": ["Pas de grille tarifaire pour AMBULANCE/05 : CA estimé à 0"]
  }
}
```

### Calcul du CA estimé d'une course

`base = baseFare + pricePerKm * max(0, directKm - includedKm)` avec la grille
(`vehicleType` du véhicule, `department` du véhicule, repli sur `"*"`).
Si la course est partagée avec `n - 1` co-passagers distincts (n plafonné à 3) :
`revenue = base * (1 - sharedDiscount{n})`. Sinon `revenue = base`.

### Codes de violation (`validation.violations[].code`)

| Code | Contrainte |
| --- | --- |
| `UNKNOWN_REFERENCE` | course ou véhicule inconnu dans le planning |
| `DUPLICATE_TRIP` | course présente plusieurs fois |
| `PAIRING` | prise en charge et dépose pas dans le même véhicule, ou dépose avant prise en charge |
| `LOCK` | course figée placée sur un autre véhicule |
| `VEHICLE_TYPE` | type de véhicule non autorisé pour la course |
| `CAPACITY` | plus de patients à bord que la capacité |
| `EXCLUSIVE_RIDE` | patient non partageable transporté avec un autre patient |
| `TIME_WINDOW` | arrivée hors fenêtre (retard au RDV, trop tôt, prise en charge hors fenêtre) |
| `TOTAL_WAIT` | attente au lieu de soins, attente à bord comprise, > `maxTotalWaitMin` : aller + retour d'un patient, ou un trajet sans son pendant |
| `RIDE_TIME` | temps à bord > trajet direct + `maxRideExtraMin` |
| `DETOUR` | détour > `min(maxDetourKmPerExtraPatient * co-passagers, maxDetourKmTotal)` |
| `SHIFT` | départ avant `shiftStartMin` ou retour après `shiftEndMin` |
| `BREAK` | pas de pause de `durationMin` sans patient à bord dans la fenêtre de pause ; ou tournée de plus de 6 h sans pause d'au moins 20 min en son sein (Code du travail, art. L. 3121-16) |
