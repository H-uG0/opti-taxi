"""Independent validator of the hard rules (contract violation codes).

It never uses the solver, the scheduler or the derived windows of `model.py`: from the request, the
travel matrix and the produced routes (with their times) it recomputes on-board patients, windows,
waits at the facility, detours, shifts and breaks with its own code, and reports every breach with
a French message. Times are whole minutes computed exactly, so the time tolerance is 0; distances
are compared with a 0.05 km tolerance for rounding.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from app.labels import hhmm, km_text, types_text, vehicle_name
from app.matrix import TravelMatrix
from app.schemas import (
    LatLng,
    OptimizeRequest,
    Route,
    RoutePlan,
    Settings,
    Stop,
    StopKind,
    StopRef,
    Trip,
    Vehicle,
    Violation,
    ViolationCode,
)
from app.traffic import stop_reference_minute

DISTANCE_TOLERANCE_KM = 0.05
TIME_TOLERANCE_MIN = 0

KIND_LABELS: dict[StopKind, str] = {"PICKUP": "prise en charge", "DROPOFF": "dépose"}


class _Collector:
    """Ordered violations without duplicates."""

    def __init__(self) -> None:
        self.items: list[Violation] = []
        self._keys: set[tuple[str, ...]] = set()

    def add(
        self,
        code: ViolationCode,
        message: str,
        *,
        trip_id: str | None = None,
        vehicle_id: str | None = None,
        key: tuple[str, ...] | None = None,
    ) -> None:
        dedup = key or (code, trip_id or "", vehicle_id or "", message)
        if dedup in self._keys:
            return
        self._keys.add(dedup)
        self.items.append(Violation(code=code, message=message, trip_id=trip_id, vehicle_id=vehicle_id))


@dataclass(frozen=True)
class _Occurrence:
    route_no: int
    position: int
    kind: StopKind
    stop: Stop
    vehicle_id: str


# --------------------------------------------------------------------------- references (/evaluate)


def check_plan_references(
    request: OptimizeRequest, plans: Sequence[RoutePlan]
) -> tuple[dict[str, list[StopRef]], list[Violation], list[str]]:
    """Clean a submitted plan before scheduling it.

    Unknown vehicles and trips are dropped (UNKNOWN_REFERENCE), repeated stops keep their first
    occurrence (DUPLICATE_TRIP), several plans of one vehicle are merged (warning).
    Returns the stop sequences per vehicle id, the violations and the warnings.
    """
    vehicles = {vehicle.id: vehicle for vehicle in request.vehicles}
    trips = {trip.id for trip in request.trips}
    out = _Collector()
    warnings: list[str] = []
    sequences: dict[str, list[StopRef]] = {}
    seen: set[tuple[str, StopKind]] = set()
    for plan in plans:
        vehicle = vehicles.get(plan.vehicle_id)
        if vehicle is None:
            out.add(
                "UNKNOWN_REFERENCE",
                f"Véhicule inconnu « {plan.vehicle_id} » dans le planning : ses {len(plan.stops)} arrêt(s) sont ignorés",
                vehicle_id=plan.vehicle_id,
            )
            continue
        if plan.vehicle_id in sequences:
            warnings.append(f"Véhicule {vehicle_name(vehicle)} présent plusieurs fois dans le planning : tournées mises bout à bout")
        sequence = sequences.setdefault(plan.vehicle_id, [])
        for stop in plan.stops:
            if stop.trip_id not in trips:
                out.add(
                    "UNKNOWN_REFERENCE",
                    f"Course inconnue « {stop.trip_id} » dans la tournée de {vehicle_name(vehicle)}",
                    trip_id=stop.trip_id,
                    vehicle_id=plan.vehicle_id,
                )
                continue
            key = (stop.trip_id, stop.kind)
            if key in seen:
                out.add(
                    "DUPLICATE_TRIP",
                    f"La {KIND_LABELS[stop.kind]} de la course {stop.trip_id} apparaît plusieurs fois dans le planning",
                    trip_id=stop.trip_id,
                    vehicle_id=plan.vehicle_id,
                )
                continue
            seen.add(key)
            sequence.append(stop)
    return sequences, out.items, warnings


# --------------------------------------------------------------------------- produced routes


def validate(request: OptimizeRequest, routes: Sequence[Route], matrix: TravelMatrix) -> list[Violation]:
    """Every hard-rule violation of the produced routes (empty list = valid plan)."""
    trips = {trip.id: trip for trip in request.trips}
    vehicles = {vehicle.id: vehicle for vehicle in request.vehicles}
    out = _Collector()
    seen: set[tuple[str, StopKind]] = set()
    occurrences: dict[str, list[_Occurrence]] = defaultdict(list)

    for route_no, route in enumerate(routes):
        vehicle = vehicles.get(route.vehicle_id)
        if vehicle is None:
            out.add("UNKNOWN_REFERENCE", f"Véhicule inconnu « {route.vehicle_id} » dans le planning", vehicle_id=route.vehicle_id)
            continue
        stops: list[tuple[Stop, Trip]] = []
        for stop in route.stops:
            trip = trips.get(stop.trip_id)
            if trip is None:
                out.add(
                    "UNKNOWN_REFERENCE",
                    f"Course inconnue « {stop.trip_id} » dans la tournée de {vehicle_name(vehicle)}",
                    trip_id=stop.trip_id,
                    vehicle_id=vehicle.id,
                )
                continue
            if (trip.id, stop.kind) in seen:
                out.add(
                    "DUPLICATE_TRIP",
                    f"La {KIND_LABELS[stop.kind]} de la course {trip.id} apparaît plusieurs fois dans le planning",
                    trip_id=trip.id,
                    vehicle_id=vehicle.id,
                )
                continue
            seen.add((trip.id, stop.kind))
            occurrences[trip.id].append(_Occurrence(route_no, len(stops), stop.kind, stop, vehicle.id))
            stops.append((stop, trip))
        _RouteCheck(out, request.settings, vehicle, route, stops, trips, matrix).run()

    _check_pairing(out, occurrences)
    _check_total_wait(out, request.settings, request.trips, occurrences)
    return out.items


def _check_pairing(out: _Collector, occurrences: Mapping[str, list[_Occurrence]]) -> None:
    for trip_id, items in occurrences.items():
        pickup = next((o for o in items if o.kind == "PICKUP"), None)
        dropoff = next((o for o in items if o.kind == "DROPOFF"), None)
        if pickup is None and dropoff is not None:
            out.add("PAIRING", f"Dépose de la course {trip_id} sans prise en charge", trip_id=trip_id, vehicle_id=dropoff.vehicle_id)
        elif dropoff is None and pickup is not None:
            out.add("PAIRING", f"Prise en charge de la course {trip_id} sans dépose", trip_id=trip_id, vehicle_id=pickup.vehicle_id)
        elif pickup is not None and dropoff is not None:
            if pickup.route_no != dropoff.route_no:
                out.add(
                    "PAIRING",
                    f"Prise en charge et dépose de la course {trip_id} dans deux véhicules différents",
                    trip_id=trip_id,
                    vehicle_id=pickup.vehicle_id,
                )
            elif dropoff.position < pickup.position:
                out.add(
                    "PAIRING",
                    f"Dépose de la course {trip_id} avant sa prise en charge",
                    trip_id=trip_id,
                    vehicle_id=pickup.vehicle_id,
                )


def _patient_pairs(trips: Sequence[Trip]) -> list[tuple[Trip, Trip]]:
    """Same-day (OUTBOUND, RETURN) pairs of each patient: a return goes with the latest outbound
    whose appointment is not after the end of session (same facility preferred)."""
    by_patient: dict[str, list[Trip]] = defaultdict(list)
    for trip in trips:
        by_patient[trip.patient_id].append(trip)
    pairs: list[tuple[Trip, Trip]] = []
    for items in by_patient.values():
        free = [t for t in items if t.direction == "OUTBOUND" and t.appointment_min is not None]
        for ret in sorted((t for t in items if t.direction == "RETURN" and t.ready_min is not None), key=lambda t: t.ready_min or 0):
            options = [o for o in free if (o.appointment_min or 0) <= (ret.ready_min or 0)]
            if not options:
                continue
            chosen = max(options, key=lambda o: (o.facility_id == ret.facility_id, o.appointment_min or 0))
            free.remove(chosen)
            pairs.append((chosen, ret))
    return pairs


def _check_total_wait(
    out: _Collector, settings: Settings, trips: Sequence[Trip], occurrences: Mapping[str, list[_Occurrence]]
) -> None:
    for outbound, ret in _patient_pairs(trips):
        dropoff = next((o for o in occurrences.get(outbound.id, []) if o.kind == "DROPOFF"), None)
        pickup = next((o for o in occurrences.get(ret.id, []) if o.kind == "PICKUP"), None)
        if dropoff is None or pickup is None or outbound.appointment_min is None or ret.ready_min is None:
            continue
        before = max(0, outbound.appointment_min - dropoff.stop.start_min)
        after = max(0, pickup.stop.start_min - ret.ready_min)
        if before + after > settings.max_total_wait_min + TIME_TOLERANCE_MIN:
            out.add(
                "TOTAL_WAIT",
                f"Attente cumulée de {before + after} min au lieu de soins (aller {before} min + retour {after} min, "
                f"maximum {settings.max_total_wait_min} min)",
                trip_id=ret.id,
                vehicle_id=pickup.vehicle_id,
            )


class _RouteCheck:
    """Rules local to one vehicle route."""

    def __init__(
        self,
        out: _Collector,
        settings: Settings,
        vehicle: Vehicle,
        route: Route,
        stops: Sequence[tuple[Stop, Trip]],
        trips: Mapping[str, Trip],
        matrix: TravelMatrix,
    ) -> None:
        self.out = out
        self.settings = settings
        self.vehicle = vehicle
        self.route = route
        self.stops = stops
        self.trips = trips
        self.matrix = matrix
        points: list[LatLng] = [vehicle.depot]
        points.extend(trip.pickup if stop.kind == "PICKUP" else trip.dropoff for stop, trip in stops)
        points.append(vehicle.depot)
        pairs = list(zip(points, points[1:], strict=False))
        references = [None, *(stop_reference_minute(trip, stop.kind, matrix) for stop, trip in stops), None]
        self.travel = [matrix.leg(a, b, references[k], references[k + 1]) for k, (a, b) in enumerate(pairs)]
        self.leg_km = [matrix.km(a, b) for a, b in pairs]
        self.departures = [route.start_min, *(stop.departure_min for stop, _ in stops)]
        self.next_starts = [*(stop.start_min for stop, _ in stops), route.end_min]
        # Patients on board on each leg (leg k + 1 starts at stop k), in pickup order.
        self.leg_sets: list[tuple[str, ...]] = [()]
        on_board: dict[str, None] = {}
        for stop, trip in stops:
            if stop.kind == "PICKUP":
                on_board[trip.id] = None
            else:
                on_board.pop(trip.id, None)
            self.leg_sets.append(tuple(on_board))

    def run(self) -> None:
        self._check_vehicle_rules()
        self._check_loads()
        self._check_times()
        self._check_shift()
        self._check_break()
        self._check_detours()

    # -- vehicle type and lock
    def _check_vehicle_rules(self) -> None:
        vid = self.vehicle.id
        for _, trip in self.stops:
            if self.vehicle.type not in trip.allowed_vehicle_types:
                self.out.add(
                    "VEHICLE_TYPE",
                    f"Course {trip.id} sur {vehicle_name(self.vehicle)} ({types_text([self.vehicle.type])}) : "
                    f"type non autorisé (autorisés : {types_text(trip.allowed_vehicle_types)})",
                    trip_id=trip.id,
                    vehicle_id=vid,
                )
            if trip.locked_vehicle_id is not None and trip.locked_vehicle_id != vid:
                self.out.add(
                    "LOCK",
                    f"Course {trip.id} figée sur « {trip.locked_vehicle_id} » mais placée sur {vehicle_name(self.vehicle)}",
                    trip_id=trip.id,
                    vehicle_id=vid,
                )

    # -- seats and exclusive rides
    def _check_loads(self) -> None:
        vid = self.vehicle.id
        for k, (stop, trip) in enumerate(self.stops):
            on_board = self.leg_sets[k + 1]
            if len(on_board) > self.vehicle.capacity:
                self.out.add(
                    "CAPACITY",
                    f"{len(on_board)} patients à bord de {vehicle_name(self.vehicle)} à {hhmm(stop.start_min)} "
                    f"(capacité {self.vehicle.capacity})",
                    trip_id=trip.id,
                    vehicle_id=vid,
                    key=("CAPACITY", vid),
                )
            if len(on_board) >= 2:
                for other_id in on_board:
                    other = self.trips[other_id]
                    if not other.shareable:
                        self.out.add(
                            "EXCLUSIVE_RIDE",
                            f"Patient non partageable (course {other_id}) transporté avec un autre patient",
                            trip_id=other_id,
                            vehicle_id=vid,
                        )

    # -- time consistency and windows
    def _break_inside(self, departure: int, next_start: int) -> int:
        slot = self.route.break_
        if slot is not None and departure <= slot.start_min and slot.end_min <= next_start:
            return slot.end_min - slot.start_min
        return 0

    def _check_times(self) -> None:
        vid = self.vehicle.id
        settings = self.settings
        for k, (departure, next_start) in enumerate(zip(self.departures, self.next_starts, strict=True)):
            needed = self.travel[k] + self._break_inside(departure, next_start)
            if next_start - departure >= needed - TIME_TOLERANCE_MIN:
                continue
            if k < len(self.stops):
                stop, trip = self.stops[k]
                self.out.add(
                    "TIME_WINDOW",
                    f"Horaire intenable : {KIND_LABELS[stop.kind]} de la course {trip.id} prévue à {hhmm(next_start)}, "
                    f"impossible avant {hhmm(departure + needed)}",
                    trip_id=trip.id,
                    vehicle_id=vid,
                )
            else:
                self.out.add(
                    "SHIFT",
                    f"Retour au dépôt de {vehicle_name(self.vehicle)} annoncé à {hhmm(next_start)}, "
                    f"impossible avant {hhmm(departure + needed)}",
                    vehicle_id=vid,
                )

        for stop, trip in self.stops:
            service = settings.pickup_service_min if stop.kind == "PICKUP" else settings.dropoff_service_min
            if stop.start_min < stop.arrival_min or stop.departure_min < stop.start_min + service:
                self.out.add(
                    "TIME_WINDOW",
                    f"Horaires incohérents à la {KIND_LABELS[stop.kind]} de la course {trip.id} "
                    f"(arrivée {hhmm(stop.arrival_min)}, début {hhmm(stop.start_min)}, départ {hhmm(stop.departure_min)})",
                    trip_id=trip.id,
                    vehicle_id=vid,
                )
            self._check_window(stop, trip)

    def _check_window(self, stop: Stop, trip: Trip) -> None:
        vid = self.vehicle.id
        start = stop.start_min
        if trip.direction == "OUTBOUND" and stop.kind == "DROPOFF" and trip.appointment_min is not None:
            appointment = trip.appointment_min
            margin = self.settings.wait_before_appointment_min
            if start > appointment + TIME_TOLERANCE_MIN:
                self.out.add(
                    "TIME_WINDOW",
                    f"Arrivée au lieu de soins à {hhmm(start)}, après le rendez-vous de {hhmm(appointment)} "
                    f"(retard de {start - appointment} min)",
                    trip_id=trip.id,
                    vehicle_id=vid,
                )
            elif start < appointment - margin - TIME_TOLERANCE_MIN:
                self.out.add(
                    "TIME_WINDOW",
                    f"Arrivée au lieu de soins à {hhmm(start)}, plus de {margin} min avant le rendez-vous de {hhmm(appointment)}",
                    trip_id=trip.id,
                    vehicle_id=vid,
                )
        if trip.direction == "RETURN" and stop.kind == "PICKUP" and trip.ready_min is not None:
            ready = trip.ready_min
            margin = self.settings.wait_after_session_min
            if start < ready - TIME_TOLERANCE_MIN:
                self.out.add(
                    "TIME_WINDOW",
                    f"Prise en charge à {hhmm(start)}, avant la fin de séance ({hhmm(ready)})",
                    trip_id=trip.id,
                    vehicle_id=vid,
                )
            elif start > ready + margin + TIME_TOLERANCE_MIN:
                self.out.add(
                    "TIME_WINDOW",
                    f"Prise en charge à {hhmm(start)}, plus de {margin} min après la fin de séance ({hhmm(ready)})",
                    trip_id=trip.id,
                    vehicle_id=vid,
                )

    # -- shift
    def _check_shift(self) -> None:
        vehicle, route = self.vehicle, self.route
        if route.start_min < vehicle.shift_start_min - TIME_TOLERANCE_MIN:
            self.out.add(
                "SHIFT",
                f"Départ du dépôt de {vehicle_name(vehicle)} à {hhmm(route.start_min)}, avant le début de service "
                f"({hhmm(vehicle.shift_start_min)})",
                vehicle_id=vehicle.id,
            )
        if route.end_min > vehicle.shift_end_min + TIME_TOLERANCE_MIN:
            self.out.add(
                "SHIFT",
                f"Retour au dépôt de {vehicle_name(vehicle)} à {hhmm(route.end_min)}, après la fin de service "
                f"({hhmm(vehicle.shift_end_min)})",
                vehicle_id=vehicle.id,
            )

    # -- driver break
    def _check_break(self) -> None:
        rule = self.vehicle.break_
        route = self.route
        if rule is None or rule.duration_min == 0 or not self.stops:
            return
        ws, we, duration = rule.window_start_min, rule.window_end_min, rule.duration_min
        vid = self.vehicle.id
        window = f"entre {hhmm(ws)} et {hhmm(we)}"
        slot = route.break_
        if slot is None:
            off_route_before = min(we, route.start_min) - ws >= duration
            off_route_after = we - max(ws, route.end_min) >= duration
            if not (off_route_before or off_route_after):
                self.out.add("BREAK", f"Aucune pause de {duration} min sans patient à bord {window}", vehicle_id=vid)
            return
        span = f"{hhmm(slot.start_min)}–{hhmm(slot.end_min)}"
        if slot.end_min - slot.start_min < duration - TIME_TOLERANCE_MIN:
            self.out.add(
                "BREAK",
                f"Pause {span} de {slot.end_min - slot.start_min} min, inférieure aux {duration} min prévues",
                vehicle_id=vid,
            )
            return
        if slot.start_min < ws - TIME_TOLERANCE_MIN or slot.end_min > we + TIME_TOLERANCE_MIN:
            self.out.add("BREAK", f"Pause {span} hors de la fenêtre de pause ({window})", vehicle_id=vid)
            return
        if slot.end_min <= route.start_min or slot.start_min >= route.end_min:
            return
        for k, (departure, next_start) in enumerate(zip(self.departures, self.next_starts, strict=True)):
            if departure <= slot.start_min and slot.end_min <= next_start:
                if self.leg_sets[k]:
                    self.out.add("BREAK", f"Pause {span} prise avec un patient à bord", vehicle_id=vid)
                return
        self.out.add("BREAK", f"La pause {span} chevauche un arrêt de la tournée", vehicle_id=vid)

    # -- detour of shared rides
    def _check_detours(self) -> None:
        settings = self.settings
        positions: dict[str, dict[StopKind, int]] = defaultdict(dict)
        for position, (stop, trip) in enumerate(self.stops):
            positions[trip.id].setdefault(stop.kind, position)
        for trip_id, kinds in positions.items():
            pickup, dropoff = kinds.get("PICKUP"), kinds.get("DROPOFF")
            if pickup is None or dropoff is None or dropoff < pickup:
                continue
            trip = self.trips[trip_id]
            # Leg k + 1 goes from stop k to stop k + 1.
            ride_km = sum(self.leg_km[pickup + 1 : dropoff + 1])
            co_passengers: set[str] = set()
            for on_board in self.leg_sets[pickup + 1 : dropoff + 1]:
                co_passengers.update(on_board)
            co_passengers.discard(trip_id)
            direct_km = self.matrix.km(trip.pickup, trip.dropoff)
            allowance = min(settings.max_detour_km_per_extra_patient * len(co_passengers), settings.max_detour_km_total)
            detour = ride_km - direct_km
            if detour > allowance + DISTANCE_TOLERANCE_KM:
                self.out.add(
                    "DETOUR",
                    f"Détour de {km_text(detour)} pour la course {trip_id} (maximum {km_text(allowance)} "
                    f"avec {len(co_passengers)} co-passager(s))",
                    trip_id=trip_id,
                    vehicle_id=self.vehicle.id,
                )
