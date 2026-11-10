"""Where one trip fits in the routes in place (POST /insert): the « Où placer cette course ? »
assistant of the planning screen, and the check of a manual move (a drop on a vehicle's row).

The routes in place stay as they are: the trip goes into one vehicle's route and, for a move, leaves
its own (the other stops keep their order, their times follow). For each vehicle of an allowed type:
1. screening: a vehicle that cannot drive the trip alone within its hours, or whose driver's break
   cannot fit its shift, is rejected (SHIFT, BREAK);
2. its route in place, with its break placed as the solver places it (_DayModel._with_break), must
   pass the solver's own checks: otherwise it already breaks a rule and gets nothing (RULES);
3. the solver's Python insertion (_DayModel: exact times, seats, exclusive rides, detour, time on
   board, wait at the facility, work time, all on the times schedule.py reports; the break moves
   when the trip only fits without it there) gives its cheapest feasible positions;
4. the OPTION_POSITIONS cheapest are timed and priced exactly (plan.route_results, as /evaluate
   reports them: sharing discount, empty leg, planned times): the best margin is kept, provided the
   independent validator finds no violation on the changed routes that they did not have before
   (the routes of the other leg of their patients are checked with them, for the total wait);
5. a vehicle without any place gets the reason the solver gives the trips it leaves out
   (_DayModel._obstacle: busy, break, no room between two stops…), within REASON_SEC.

No OR-Tools routing model is built (9 s at 120 vehicles and 300 trips): only the nodes of the
candidate vehicles' routes and of the trip are laid out. The trip's own lock is lifted: the regulator
is placing it. The figures of an option are differences with the routes in place: km, km driven
empty, duration, revenue, cost and margin of the two routes it changes, and the times of the other
patients of these routes that move.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from app.context import PlanContext, make_context, request_points
from app.labels import hhmm
from app.matrix import TravelMatrix, build_matrix, configured_osrm_url
from app.plan import route_results
from app.schedule import RouteSchedule
from app.schemas import (
    InsertOption,
    InsertRejection,
    InsertRequest,
    InsertResponse,
    Meta,
    RejectionKind,
    Route,
    RoutePlan,
    StopRef,
    TimeShift,
    Trip,
    TripResult,
    Violation,
)
from app.solver import (
    CENTS_PER_EURO,
    METERS_PER_KM,
    UNITS_PER_CENT,
    FleetVehicle,
    Node,
    Role,
    _DayModel,
    _reachable_alone,
    usable_fleet,
)
from app.traffic import with_traffic
from app.validator import check_plan_references, validate, validate_revenue

STATUS_INSERT = "INSERT"
"""meta.solverStatus of an /insert answer."""
OPTION_POSITIONS = 3
"""Cheapest feasible positions of each vehicle priced exactly: the sharing discount, outside the
insertion cost (km and minutes), can make a dearer position earn more."""
REASON_SEC = 0.6
"""Most time spent telling why each vehicle without a place cannot take the trip."""
MONEY_DIGITS = 2
KM_DIGITS = 2
PATIENT_WIDE_CODES = frozenset({"TOTAL_WAIT"})
"""Violations of a patient across their outbound and return, possibly on two vehicles."""

REASON_OFF_FLEET = "ne roule pas ce jour, la pause de son chauffeur ne tenant pas dans son horaire"
REASON_ROUTE_BROKEN = "a une tournée enregistrée incohérente, un arrêt sans sa prise en charge ou sa dépose (réoptimisez d'abord)"
REASON_ROUTE_OFF_RULES = (
    "a une tournée qui ne respecte déjà plus les horaires, la pause ou les temps à bord (réoptimisez ou corrigez-la d'abord)"
)
REASON_NO_TIME_LEFT = "n'a pas de place pour elle dans sa tournée"
OBSTACLE_KINDS: dict[str, RejectionKind] = {
    "alone": "BREAK",
    "busy": "OCCUPIED",
    "share": "OCCUPIED",
    "break": "BREAK",
    "tight": "NO_ROOM",
    "free": "NO_ROOM",
}
"""Kind of each obstacle of _DayModel._obstacle (« tight » without any stop: its hours, see _rejection)."""
OFF_SHIFT_TEXTS = ("n'a pas le temps de l'assurer dans ses heures de service",)


class _MeterRow:
    __slots__ = ("_matrix", "_point", "_points")

    def __init__(self, matrix: TravelMatrix, point: int, points: Sequence[int]) -> None:
        self._matrix, self._point, self._points = matrix, point, points

    def __getitem__(self, node: int) -> int:
        return round(self._matrix.km_by_index(self._point, self._points[node]) * METERS_PER_KM)


class _MeterRows:
    """Meters between two nodes, rounded like the routing model's Distance dimension, read as
    rows[a][b] (_DayModel._meter_rows) but computed on demand: no table of every node pair."""

    def __init__(self, nodes: Sequence[Node], matrix: TravelMatrix) -> None:
        self._points = [node.point for node in nodes]
        self._matrix = matrix

    def __getitem__(self, node: int) -> _MeterRow:
        return _MeterRow(self._matrix, self._points[node], self._points)


class _InsertionModel(_DayModel):
    """The solver's day model without its OR-Tools routing model: the nodes of the routes in place
    of the candidate vehicles and of the trip to place, and the Python checks and insertion."""

    def _break_site_vehicles(self) -> dict[str, frozenset[int]]:
        # Every trip in place stays on its vehicle, the trip to place may go to its candidates.
        return {trip.id: frozenset(candidates) for trip, candidates in self.routable}

    def _make_model(self) -> None:
        settings = self.ctx.request.settings
        self._lost_cents = self._lost_revenue_cents()
        self._meter_rows = _MeterRows(self.nodes, self.ctx.matrix)  # type: ignore[assignment]  # read as rows[a][b] only
        allowance_m = round(min(settings.max_detour_km_per_extra_patient, settings.max_detour_km_total) * METERS_PER_KM)
        for trip, candidates in self.routable:
            penalty = (settings.unassigned_penalty + self.best_revenue(trip, candidates)) * CENTS_PER_EURO * UNITS_PER_CENT
            self.drop_penalty[trip.id] = round(penalty)
            if trip.shareable and any(self.fleet[v].vehicle.capacity > 1 for v in candidates):
                p_node, d_node = self.trip_nodes[trip.id]
                self.detour_limits_m[trip.id] = self._meter_rows[p_node][d_node] + allowance_m

    def sequence_of(self, refs: Sequence[StopRef]) -> list[int]:
        """Routing indices of the stops (their trips have nodes: see _routable)."""
        return [self.manager.NodeToIndex(self.trip_nodes[ref.trip_id][0 if ref.kind == "PICKUP" else 1]) for ref in refs]

    def refs_of(self, sequence: Sequence[int]) -> list[StopRef]:
        """The stops of a route, break nodes left out (schedule.py places the break)."""
        refs: list[StopRef] = []
        for index in sequence:
            node = self.node_at(index)
            if node.trip is not None and node.role in (Role.PICKUP, Role.DELIVERY):
                refs.append(StopRef(trip_id=node.trip.id, kind="PICKUP" if node.role is Role.PICKUP else "DROPOFF"))
        return refs

    def in_place(self, v: int, refs: Sequence[StopRef]) -> list[int] | None:
        """The route in place of vehicle v with its break where the solver puts it, None when it
        does not pass the solver's checks (it already breaks a rule)."""
        sequence = self.sequence_of(refs)
        if v in self.break_nodes:
            return self._with_break(sequence, v)
        return sequence if self._fits(v, sequence) else None

    def feasible_insertions(self, route: Sequence[int], v: int, trip: Trip, most: int) -> list[list[int]]:
        """Up to `most` feasible routes of vehicle v with the trip inserted, cheapest first; the
        break moves when the trip fits nowhere around it (_DayModel._cheapest_insertion)."""
        found: list[list[int]] = []
        for _, i, j in self._insertion_positions(route, v, trip):
            sequence = self._inserted(route, trip, i, j)
            if not self._detour_breaches(sequence) and self._fits(v, sequence):
                found.append(sequence)
                if len(found) >= most:
                    return found
        if not found and (moved := self._insertion_moving_break(route, v, trip)) is not None:
            found.append(moved[1])
        return found

    def obstacle(self, v: int, route: Sequence[int], trip: Trip, schedules: dict[int, RouteSchedule | None]) -> tuple[str, str]:
        """What keeps vehicle v from taking the trip (_DayModel._obstacle)."""
        return self._obstacle(v, route, trip, self.ride_span(trip)[2], schedules)


@dataclass(frozen=True)
class _Figures:
    """The routes of some vehicles and the results of their trips, as /evaluate reports them."""

    routes: tuple[Route, ...]
    trips: tuple[TripResult, ...]

    @property
    def km(self) -> float:
        return sum(route.distance_km for route in self.routes)

    @property
    def empty_km(self) -> float:
        return sum(route.empty_km for route in self.routes)

    @property
    def duration(self) -> int:
        return sum(route.duration_min for route in self.routes)

    @property
    def revenue(self) -> float:
        return sum(route.revenue for route in self.routes)

    @property
    def cost(self) -> float:
        return sum(route.cost for route in self.routes)

    def __add__(self, other: _Figures) -> _Figures:
        return _Figures(self.routes + other.routes, self.trips + other.trips)


NO_FIGURES = _Figures((), ())


def _figures(ctx: PlanContext, vehicle_id: str, refs: Sequence[StopRef]) -> _Figures:
    if not refs:
        return NO_FIGURES
    routes, trips = route_results(ctx, {vehicle_id: refs})
    return _Figures(tuple(routes), tuple(trips))


def _complete_trips(refs: Sequence[StopRef]) -> list[str] | None:
    """Trips of a route picked up then dropped off once each, in order; None when a stop has no
    partner on the route or comes in the wrong order (a stored route edited by hand)."""
    picked: dict[str, None] = {}
    done: dict[str, None] = {}
    for ref in refs:
        if ref.kind == "PICKUP":
            if ref.trip_id in picked or ref.trip_id in done:
                return None
            picked[ref.trip_id] = None
        elif ref.trip_id in picked:
            del picked[ref.trip_id]
            done[ref.trip_id] = None
        else:
            return None
    return None if picked else list(done)


def _key(violation: Violation) -> tuple[str, str | None, str | None]:
    return (violation.code, violation.trip_id, violation.vehicle_id)


class _Checker:
    """The independent validator on the routes an insertion changes, against the same routes in
    place: an option may keep what they already broke, never break something new."""

    def __init__(self, ctx: PlanContext, in_place: Mapping[str, Sequence[StopRef]]) -> None:
        self.ctx = ctx
        self.in_place = in_place
        self._figures: dict[str, _Figures] = {}
        self._vehicle_of: dict[str, str] = {ref.trip_id: vid for vid, refs in in_place.items() for ref in refs}
        self._trips_of: dict[str, list[str]] = {}
        for trip in ctx.request.trips:
            self._trips_of.setdefault(trip.patient_id, []).append(trip.id)

    def figures(self, vehicle_id: str) -> _Figures:
        """The route in place of the vehicle (cached)."""
        if vehicle_id not in self._figures:
            self._figures[vehicle_id] = _figures(self.ctx, vehicle_id, self.in_place.get(vehicle_id, ()))
        return self._figures[vehicle_id]

    def _relevant(self, found: Sequence[Violation], vehicles: set[str], trip_ids: set[str]) -> list[Violation]:
        patients = {self.ctx.trips[t].patient_id for t in trip_ids if t in self.ctx.trips}
        kept: list[Violation] = []
        for violation in found:
            if violation.vehicle_id in vehicles or violation.trip_id in trip_ids:
                kept.append(violation)
            elif violation.code in PATIENT_WIDE_CODES and violation.trip_id in self.ctx.trips:
                if self.ctx.trips[violation.trip_id].patient_id in patients:
                    kept.append(violation)
        return kept

    def _partners(self, vehicles: set[str], trip_ids: set[str]) -> list[Route]:
        """Routes in place holding another trip of the patients of `trip_ids` (total wait)."""
        others: dict[str, None] = {}
        for trip_id in trip_ids:
            for other in self._trips_of.get(self.ctx.trips[trip_id].patient_id, ()):
                vehicle_id = self._vehicle_of.get(other)
                if vehicle_id is not None and vehicle_id not in vehicles:
                    others[vehicle_id] = None
        return [route for vehicle_id in others for route in self.figures(vehicle_id).routes]

    def check(self, before: _Figures, after: _Figures, vehicles: set[str]) -> tuple[list[Violation], list[Violation]]:
        """(violations of the changed routes after the insertion, those of them that are new)."""
        trip_ids = {result.trip_id for result in (*before.trips, *after.trips)}
        partners = self._partners(vehicles, trip_ids)
        request, matrix = self.ctx.request, self.ctx.matrix
        found_before = [
            *validate(request, [*before.routes, *partners], matrix),
            *validate_revenue(request, before.routes, before.trips, matrix),
        ]
        found_after = [
            *validate(request, [*after.routes, *partners], matrix),
            *validate_revenue(request, after.routes, after.trips, matrix),
        ]
        after_relevant = self._relevant(found_after, vehicles, trip_ids)
        known = {_key(violation) for violation in self._relevant(found_before, vehicles, trip_ids)}
        return after_relevant, [violation for violation in after_relevant if _key(violation) not in known]


def _shifts(before: _Figures, after: _Figures, placed: str) -> list[TimeShift]:
    """The other trips of the changed routes whose pickup or dropoff starts at another minute."""
    former = {result.trip_id: result for result in before.trips}
    shifts: list[TimeShift] = []
    for result in after.trips:
        old = former.get(result.trip_id)
        if result.trip_id == placed or old is None:
            continue
        if None in (result.pickup_min, result.dropoff_min, old.pickup_min, old.dropoff_min):
            continue
        assert result.pickup_min is not None and result.dropoff_min is not None
        assert old.pickup_min is not None and old.dropoff_min is not None
        if (result.pickup_min, result.dropoff_min) != (old.pickup_min, old.dropoff_min):
            shifts.append(
                TimeShift(
                    trip_id=result.trip_id,
                    pickup_min=result.pickup_min,
                    dropoff_min=result.dropoff_min,
                    pickup_shift_min=result.pickup_min - old.pickup_min,
                    dropoff_shift_min=result.dropoff_min - old.dropoff_min,
                )
            )
    return shifts


def _option(vehicle_id: str, trip_id: str, before: _Figures, after: _Figures, violations: list[Violation]) -> InsertOption | None:
    placed = next((result for result in after.trips if result.trip_id == trip_id), None)
    if placed is None or placed.pickup_min is None or placed.dropoff_min is None:
        return None
    revenue = round(after.revenue - before.revenue, MONEY_DIGITS)
    cost = round(after.cost - before.cost, MONEY_DIGITS)
    return InsertOption(
        vehicle_id=vehicle_id,
        pickup_min=placed.pickup_min,
        dropoff_min=placed.dropoff_min,
        shared=placed.shared,
        co_passenger_trip_ids=placed.co_passenger_trip_ids,
        delta_km=round(after.km - before.km, KM_DIGITS),
        delta_empty_km=round(after.empty_km - before.empty_km, KM_DIGITS),
        delta_duration_min=after.duration - before.duration,
        delta_revenue=revenue,
        delta_cost=cost,
        delta_margin=round(revenue - cost, MONEY_DIGITS),
        shifts=_shifts(before, after, trip_id),
        routes=list(after.routes),
        trips=list(after.trips),
        violations=violations,
    )


def _rejection(model: _InsertionModel, v: int, kind: str, text: str) -> tuple[RejectionKind, str]:
    if kind == "tight" and text in OFF_SHIFT_TEXTS:
        return "SHIFT", text
    if kind == "alone" and v not in model.break_nodes:
        return "SHIFT", text
    return OBSTACLE_KINDS.get(kind, "NO_ROOM"), text


def _shift_text(member: FleetVehicle) -> str:
    return f"ne peut pas l'assurer dans ses heures de service ({hhmm(member.shift.open)}–{hhmm(member.shift.close)})"


def insert(request: InsertRequest) -> InsertResponse:
    """Best place of request.tripId in each vehicle's route in place, or why there is none."""
    started = time.perf_counter()
    trips = [trip.model_copy(update={"locked_vehicle_id": None}) if trip.id == request.trip_id else trip for trip in request.trips]
    day = request.model_copy(update={"trips": trips})
    matrix, warnings = build_matrix(request_points(day), configured_osrm_url())
    ctx = make_context(day, with_traffic(matrix, day.settings.traffic))
    warnings.extend(ctx.tariffs.missing_warnings(day.vehicles))
    sequences, _, reference_warnings = check_plan_references(day, day.routes)
    warnings.extend(reference_warnings)
    trip = ctx.trips[day.trip_id]
    source = next((vid for vid, refs in sequences.items() if any(ref.trip_id == trip.id for ref in refs)), None)
    in_place: dict[str, list[StopRef]] = {vid: list(refs) for vid, refs in sequences.items()}
    without: dict[str, list[StopRef]] = {vid: [ref for ref in refs if ref.trip_id != trip.id] for vid, refs in in_place.items()}

    fleet, _ = usable_fleet(ctx)
    position = {member.vehicle.id: v for v, member in enumerate(fleet)}
    wanted = None if day.vehicle_ids is None else set(day.vehicle_ids)
    rejected: dict[str, InsertRejection] = {}
    screened: list[int] = []
    for vehicle in day.vehicles:
        if vehicle.id == source or vehicle.type not in trip.allowed_vehicle_types or (wanted is not None and vehicle.id not in wanted):
            continue
        v = position.get(vehicle.id)
        if v is None:
            rejected[vehicle.id] = InsertRejection(vehicle_id=vehicle.id, kind="BREAK", reason=REASON_OFF_FLEET)
        elif not _reachable_alone(ctx, trip, fleet[v]):
            rejected[vehicle.id] = InsertRejection(vehicle_id=vehicle.id, kind="SHIFT", reason=_shift_text(fleet[v]))
        else:
            screened.append(v)

    routable: list[tuple[Trip, list[int]]] = []
    plans: list[RoutePlan] = []
    candidates: list[int] = []
    for v in screened:
        vehicle_id = fleet[v].vehicle.id
        refs = without.get(vehicle_id, [])
        complete = _complete_trips(refs)
        if complete is None:
            rejected[vehicle_id] = InsertRejection(vehicle_id=vehicle_id, kind="RULES", reason=REASON_ROUTE_BROKEN)
            continue
        routable.extend((ctx.trips[trip_id], [v]) for trip_id in complete)
        plans.append(RoutePlan(vehicle_id=vehicle_id, stops=refs))
        candidates.append(v)

    checker = _Checker(ctx, in_place)
    source_before = checker.figures(source) if source is not None else NO_FIGURES
    source_after = _figures(ctx, source, without[source]) if source is not None else NO_FIGURES
    options: list[InsertOption] = []
    if candidates:
        model = _InsertionModel(ctx, fleet, [*routable, (trip, candidates)], plans)
        model._exact_checks = True  # every check on the times schedule.py reports
        routes: dict[int, list[int]] = {}
        without_place: list[int] = []
        for v in candidates:
            vehicle_id = fleet[v].vehicle.id
            refs = without.get(vehicle_id, [])
            route = model.in_place(v, refs)
            if route is None:
                # A vehicle without a route whose break fits nowhere: its hours, not a route breaking a rule.
                kind, reason = ("RULES", REASON_ROUTE_OFF_RULES) if refs else ("BREAK", REASON_OFF_FLEET)
                rejected[vehicle_id] = InsertRejection(vehicle_id=vehicle_id, kind=kind, reason=reason)
                continue
            routes[v] = route
            option, refused = _best_option(ctx, model, checker, trip, v, route, source, source_before, source_after)
            if option is not None:
                options.append(option)
            elif refused is not None:
                rejected[vehicle_id] = InsertRejection(vehicle_id=vehicle_id, kind="RULES", reason=refused)
            else:
                without_place.append(v)
        reasons_by = time.monotonic() + REASON_SEC
        schedules: dict[int, RouteSchedule | None] = {}
        for v in without_place:
            vehicle_id = fleet[v].vehicle.id
            if time.monotonic() >= reasons_by:
                kind, text = "NO_ROOM", REASON_NO_TIME_LEFT
            else:
                kind, text = _rejection(model, v, *model.obstacle(v, routes[v], trip, schedules))
            rejected[vehicle_id] = InsertRejection(vehicle_id=vehicle_id, kind=kind, reason=text)

    order = {vehicle.id: k for k, vehicle in enumerate(day.vehicles)}
    options.sort(key=lambda option: (-option.delta_margin, option.delta_km, order[option.vehicle_id]))
    response = InsertResponse(
        trip_id=trip.id,
        from_vehicle_id=source,
        options=options,
        rejected=sorted(rejected.values(), key=lambda item: order[item.vehicle_id]),
        meta=Meta(
            matrix_source=ctx.matrix.source,
            traffic_source=ctx.matrix.traffic_source,
            solver_status=STATUS_INSERT,
            objective=None,
            wall_time_ms=round((time.perf_counter() - started) * 1000),
            warnings=warnings,
        ),
    )
    return response


def _best_option(
    ctx: PlanContext,
    model: _InsertionModel,
    checker: _Checker,
    trip: Trip,
    v: int,
    route: Sequence[int],
    source: str | None,
    source_before: _Figures,
    source_after: _Figures,
) -> tuple[InsertOption | None, str | None]:
    """The best-margin place of the trip in vehicle v's route that breaks no new rule, or (None, why
    the validator refused every feasible place), or (None, None) when the trip fits nowhere."""
    vehicle_id = model.fleet[v].vehicle.id
    before = checker.figures(vehicle_id) + source_before
    priced: list[tuple[float, float, int, _Figures]] = []
    for rank, sequence in enumerate(model.feasible_insertions(route, v, trip, OPTION_POSITIONS)):
        after = _figures(ctx, vehicle_id, model.refs_of(sequence)) + source_after
        priced.append((-(after.revenue - after.cost), after.km, rank, after))
    priced.sort(key=lambda item: item[:3])
    refused: str | None = None
    vehicles = {vehicle_id} | ({source} if source is not None else set())
    for *_, after in priced:
        violations, new = checker.check(before, after, vehicles)
        if new:
            refused = f"ne peut pas la prendre sans enfreindre une règle ({new[0].message})"
            continue
        return _option(vehicle_id, trip.id, before, after, violations), None
    return None, refused
