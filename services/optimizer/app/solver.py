"""OR-Tools model of a planning day: pickup and delivery with time windows (PDPTW).

Nodes
- one depot node per vehicle (start and end of its route);
- two nodes per trip: pickup and delivery (AddPickupAndDelivery, same vehicle, pickup first,
  both performed or both dropped);
- driver break sites of a vehicle whose break may fall inside its working time
  (BreakMode.NODE): its depot and the facilities of the trips it may serve. Exactly one is visited
  inside the break window, with a service time equal to the break and the seats cumul forced to 0
  (the vehicle is empty during the whole break; the driving to reach the site is counted).
  Known gap: a route that ends before the window (or starts after it) still visits its site
  inside the window, so the objective pays the idle time up to the break, while the recomputed
  plan puts the break after the return (README, "Limites connues"). Zero-cost "before departure"
  / "after return" nodes remove that gap, but a route holding one cannot take a trip on the other
  side of the window without a compound move: on the busy-day benchmark they served as many trips
  at 10 s and fewer at 30 s, so they were not kept.

Hard constraints
- allowed vehicles per trip (prescribed types, regulator lock) on the vehicle variable domain;
- seats (capacity dimension);
- exclusive rides: a second capacity dimension where a non-shareable patient weighs the whole
  vehicle, so nobody else can be on board with them;
- time windows (time dimension in minutes, service times included, slack = waiting) and shifts;
- detour: pickup-to-delivery limit on the distance dimension (meters) of a shareable trip,
  ride <= direct + min(maxDetourKmPerExtraPatient, maxDetourKmTotal). One co-passenger is the
  minimum of a shared ride, so the bound is valid whatever the number of co-passengers (it equals
  the rule for 2-seat vehicles and is conservative above);
- total wait at the facility: guaranteed by the derived windows (see model.py);
- driver break: the break sites form a disjunction whose penalty dominates every other cost.

Every rule uses a routing primitive (dimension, pickup-to-delivery limit, vehicle domain,
disjunction) that the routing filters check at each insertion and local-search move. A constraint
posted on cumul variables with solver.Add() is only checked by propagation after the filters
accepted a move: with the detour and precedences written that way, the first solution of a
160-trip day took 6 to 10 s instead of 1.5 s.

Objective (integer cents): km x costPerKm per vehicle on every arc; minutes x costPerHour / 60 on
the route span; revenue lost against the best vehicle type for the trip on the arc leaving its
pickup (picks the vehicle type that earns most); dropping a trip costs unassignedPenalty + its best
revenue (twice that for a trip locked by the regulator). Unused vehicles only carry their break
(depot site, no km), a constant. The shared-ride discount is not in the objective (not linear): it
is applied when the plan is recomputed.

Search (budget = settings.timeLimitSec, counted from the start of the search)
1. First solution: PARALLEL_CHEAPEST_INSERTION, run to completion (stopped early, it leaves most
   trips unplaced), even FIRST_SOLUTION_GRACE_SEC past the budget. Break sites are inserted after
   the trips, so a busy vehicle may get none.
2. Break repair: a vehicle left without a break gets one at the cheapest feasible empty position,
   removing the trips that ride through the break window if needed. Exact time and detour checks
   in Python (milliseconds), then the routing model confirms the whole plan once.
3. GUIDED_LOCAL_SEARCH on the remaining budget, from a plan where every break is performed:
   dropping a break would cost more than all the trips, so the best plan keeps them.
"""

from __future__ import annotations

import logging
import math
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from enum import Enum

from ortools.constraint_solver import pywrapcp, routing_enums_pb2, routing_parameters_pb2

from app.context import PlanContext
from app.labels import hhmm, types_text, vehicle_name
from app.model import FREE_WINDOW, HORIZON_MIN, BreakMode, BreakPlan, Window, break_plan, effective_shift, is_compatible
from app.pricing import base_revenue
from app.schemas import LatLng, PlanStatus, StopRef, Trip, Vehicle

logger = logging.getLogger("optimizer.solver")

CENTS_PER_EURO = 100
METERS_PER_KM = 1000
EXCLUSIVE_WEIGHT = 100
"""Exclusive-ride load of a non-shareable patient (vehicle limit); shareable patients weigh 1."""
MAX_BREAK_SITES = 12
LOCKED_PENALTY_FACTOR = 2
MAX_ROUTE_METERS = 10_000_000
BREAK_PENALTY = 10**13
"""Cost (cents) of a vehicle without its break: more than any set of trips."""
MIN_LOCAL_SEARCH_SEC = 0.2
"""Below this remaining budget, the repaired first solution is returned as is."""
FIRST_SOLUTION_GRACE_SEC = 5
"""Extra time the first solution may take beyond the budget: interrupted, the insertion heuristic
leaves most trips unplaced (none of 160 with a 1 s budget). The web client waits the budget + 30 s."""

REASON_DROPPED = "Pas de place dans les tournées : conflit d'horaires, de capacité ou de pause avec les autres courses"
REASON_DROPPED_TIME_LIMIT = (
    "Non placée dans le temps de calcul imparti : augmenter le temps de calcul (Paramètres) ou placer la course à la main"
)
REASON_NO_SOLUTION = "Aucune solution trouvée dans le temps de calcul imparti"

SEARCH_COMPLETE_STATUSES = frozenset({"ROUTING_SUCCESS", "ROUTING_OPTIMAL"})
MIN_RECOMMENDED_SEC = 10
TRIPS_PER_RECOMMENDED_SEC = 8
"""Recommended budget: one second per 8 trips, at least 10 s (see recommended_time_limit_sec)."""


class Role(Enum):
    DEPOT = "depot"
    PICKUP = "pickup"
    DELIVERY = "delivery"
    BREAK = "break"


@dataclass(frozen=True)
class Node:
    role: Role
    point: int
    """Row of the travel matrix."""
    service_min: int = 0
    window: Window = FREE_WINDOW
    seats: int = 0
    exclusive: int = 0
    trip: Trip | None = None
    vehicle: int | None = None
    """Owner vehicle (fleet position) of a depot or break node."""


@dataclass(frozen=True)
class FleetVehicle:
    vehicle: Vehicle
    breaks: BreakPlan
    shift: Window


@dataclass
class SolveOutcome:
    sequences: dict[str, list[StopRef]]
    unassigned: dict[str, str]
    status: PlanStatus
    solver_status: str
    objective: float | None
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- screening


def usable_fleet(ctx: PlanContext) -> tuple[list[FleetVehicle], list[str]]:
    """Vehicles the solver can use, and warnings for the others."""
    fleet: list[FleetVehicle] = []
    warnings: list[str] = []
    for vehicle in ctx.request.vehicles:
        plan = break_plan(vehicle)
        if plan.mode is BreakMode.IMPOSSIBLE:
            warnings.append(f"{vehicle_name(vehicle)} non utilisé : sa pause ne peut pas être placée dans son horaire")
            continue
        fleet.append(FleetVehicle(vehicle, plan, effective_shift(vehicle, plan)))
    return fleet, warnings


def _reachable_alone(ctx: PlanContext, trip: Trip, member: FleetVehicle) -> bool:
    """Can the vehicle do this trip alone (depot -> pickup -> dropoff -> depot) within its shift?"""
    matrix, settings = ctx.matrix, ctx.request.settings
    windows = ctx.windows[trip.id]
    depot = member.vehicle.depot
    pickup_start = max(member.shift.open + matrix.minutes(depot, trip.pickup), windows.pickup.open)
    if pickup_start > windows.pickup.close:
        return False
    arrival = pickup_start + settings.pickup_service_min + matrix.minutes(trip.pickup, trip.dropoff)
    dropoff_start = max(arrival, windows.dropoff.open)
    if dropoff_start > windows.dropoff.close:
        return False
    back = dropoff_start + settings.dropoff_service_min + matrix.minutes(trip.dropoff, depot)
    return back <= member.shift.close


def screen_trip(ctx: PlanContext, trip: Trip, fleet: Sequence[FleetVehicle]) -> tuple[list[int], str | None]:
    """Fleet positions able to serve the trip, or a French reason why none can."""
    if trip.locked_vehicle_id is not None:
        locked = ctx.vehicles.get(trip.locked_vehicle_id)
        if locked is None:
            return [], f"Véhicule figé « {trip.locked_vehicle_id} » absent de la flotte du jour"
        if locked.type not in trip.allowed_vehicle_types:
            return [], (
                f"Véhicule figé {vehicle_name(locked)} d'un type non autorisé pour cette course "
                f"(autorisés : {types_text(trip.allowed_vehicle_types)})"
            )
        if all(member.vehicle.id != locked.id for member in fleet):
            return [], f"Véhicule figé {vehicle_name(locked)} inutilisable : sa pause ne tient pas dans son horaire"

    typed = [i for i, member in enumerate(fleet) if is_compatible(trip, member.vehicle)]
    if not typed:
        return [], f"Aucun véhicule de type autorisé ({types_text(trip.allowed_vehicle_types)}) disponible ce jour"
    reachable = [i for i in typed if _reachable_alone(ctx, trip, fleet[i])]
    if reachable:
        return reachable, None
    if trip.locked_vehicle_id is not None:
        return [], f"Horaires inatteignables pour le véhicule figé {vehicle_name(fleet[typed[0]].vehicle)} dans ses heures de service"
    when = (
        f"rendez-vous à {hhmm(trip.appointment_min)}"
        if trip.direction == "OUTBOUND" and trip.appointment_min is not None
        else f"fin de séance à {hhmm(trip.ready_min or 0)}"
    )
    return [], (
        f"Horaires inatteignables ({when}) : aucun véhicule compatible ne peut assurer la course "
        "depuis son dépôt dans ses heures de service"
    )


def _allow_vehicles(routing: pywrapcp.RoutingModel, index: int, vehicles: Sequence[int]) -> None:
    """Only these vehicles may visit `index` (-1 keeps the node droppable when it is optional).

    Same effect as RoutingModel.SetAllowedVehiclesForIndex, whose Python binding rejects its
    absl::Span argument in this OR-Tools build; the vehicle-variable filter enforces it in search.
    """
    routing.VehicleVar(index).SetValues([-1, *vehicles])


def _status_name(routing: pywrapcp.RoutingModel) -> str:
    status = routing.status()
    try:
        return routing_enums_pb2.RoutingSearchStatus.Value.Name(status)
    except ValueError:
        return f"STATUS_{status}"


# --------------------------------------------------------------------------- model


class _DayModel:
    """Node layout, OR-Tools routing model and search of one request."""

    def __init__(self, ctx: PlanContext, fleet: Sequence[FleetVehicle], routable: Sequence[tuple[Trip, list[int]]]) -> None:
        self.ctx = ctx
        self.fleet = fleet
        self.routable = routable
        self.nodes: list[Node] = []
        self.trip_nodes: dict[str, tuple[int, int]] = {}
        self.break_nodes: dict[int, list[int]] = {}
        """Break sites (node numbers) of each vehicle with a break node, its depot first."""
        self.detour_limits_m: dict[str, int] = {}
        """Longest allowed ride (meters) of each shareable trip."""
        self.drop_penalty: dict[str, int] = {}
        """Objective cost (cents) of leaving each trip unassigned."""
        self.search_status = "ROUTING_NOT_SOLVED"
        """Status of the last solver run (the routing status changes when an assignment is read)."""
        self._meter_rows: list[list[int]] = []
        self._limit_functions: list[Callable[[int, int], int]] = []
        """Pickup-to-delivery limit callbacks, kept alive while the C++ model uses them."""
        self._layout()
        self.manager = pywrapcp.RoutingIndexManager(len(self.nodes), len(fleet), list(range(len(fleet))), list(range(len(fleet))))
        self.routing = pywrapcp.RoutingModel(self.manager)
        self._build()

    # -- nodes
    def _point(self, location: LatLng) -> int:
        return self.ctx.matrix.index_of(location)

    def _layout(self) -> None:
        settings = self.ctx.request.settings
        for v, member in enumerate(self.fleet):
            self.nodes.append(Node(Role.DEPOT, self._point(member.vehicle.depot), vehicle=v))
        for trip, _ in self.routable:
            windows = self.ctx.windows[trip.id]
            weight = 1 if trip.shareable else EXCLUSIVE_WEIGHT
            pickup = Node(Role.PICKUP, self._point(trip.pickup), settings.pickup_service_min, windows.pickup, 1, weight, trip)
            delivery = Node(
                Role.DELIVERY, self._point(trip.dropoff), settings.dropoff_service_min, windows.dropoff, -1, -weight, trip
            )
            self.trip_nodes[trip.id] = (len(self.nodes), len(self.nodes) + 1)
            self.nodes.extend((pickup, delivery))
        for v, member in enumerate(self.fleet):
            rule = member.vehicle.break_
            if member.breaks.mode is not BreakMode.NODE or member.breaks.window is None or rule is None:
                continue
            self.break_nodes[v] = []
            for point in self._break_sites(v, member, member.breaks.window, rule.duration_min):
                self.break_nodes[v].append(len(self.nodes))
                self.nodes.append(Node(Role.BREAK, point, rule.duration_min, member.breaks.window, vehicle=v))

    def _break_sites(self, v: int, member: FleetVehicle, window: Window, duration: int) -> list[int]:
        """Depot first, then the facilities of the trips this vehicle may serve, nearest first."""
        matrix = self.ctx.matrix
        depot = self._point(member.vehicle.depot)
        facilities: dict[int, None] = {}
        for trip, candidates in self.routable:
            if v in candidates:
                facilities.setdefault(self._point(trip.dropoff if trip.direction == "OUTBOUND" else trip.pickup), None)
        facilities.pop(depot, None)
        nearest = sorted(facilities, key=lambda p: matrix.km_by_index(depot, p))[: MAX_BREAK_SITES - 1]
        sites = [depot]
        for point in nearest:
            begin = max(member.shift.open + matrix.minutes_by_index(depot, point), window.open)
            if begin <= window.close and begin + duration + matrix.minutes_by_index(point, depot) <= member.shift.close:
                sites.append(point)
        return sites

    def node_at(self, index: int) -> Node:
        return self.nodes[self.manager.IndexToNode(index)]

    # -- costs and transit tables
    @staticmethod
    def _tariff_key(vehicle: Vehicle) -> tuple[str, str]:
        return (vehicle.type, vehicle.department)

    def _lost_revenue_cents(self) -> list[dict[tuple[str, str], int]]:
        """Per pickup node: revenue lost (cents) with each candidate tariff vs the best one."""
        lost: list[dict[tuple[str, str], int]] = [{} for _ in self.nodes]
        tariffs = self.ctx.tariffs
        for trip, candidates in self.routable:
            direct = self.ctx.direct_km(trip)
            revenue = {
                self._tariff_key(self.fleet[v].vehicle): base_revenue(tariffs.for_vehicle(self.fleet[v].vehicle), direct)
                for v in candidates
            }
            best = max(revenue.values(), default=0.0)
            pickup, _ = self.trip_nodes[trip.id]
            lost[pickup] = {key: round((best - value) * CENTS_PER_EURO) for key, value in revenue.items()}
        return lost

    def best_revenue(self, trip: Trip, candidates: Sequence[int]) -> float:
        direct = self.ctx.direct_km(trip)
        return max((base_revenue(self.ctx.tariffs.for_vehicle(self.fleet[v].vehicle), direct) for v in candidates), default=0.0)

    def _point_rows(self, table: Sequence[Sequence[float]], scale: float) -> dict[int, list[int]]:
        """round(table[p][q] * scale) towards every node, for each distinct point p of the nodes.

        Many nodes share a place (depots, facilities, break sites): one row per place keeps the
        model build fast.
        """
        columns = [node.point for node in self.nodes]
        return {p: [round(table[p][q] * scale) for q in columns] for p in dict.fromkeys(columns)}

    def _node_rows(self, point_rows: dict[int, list[int]], extra: Sequence[int]) -> list[list[int]]:
        """Transit row of each node: the row of its place, plus its extra term when not 0."""
        return [
            point_rows[node.point] if not bonus else [value + bonus for value in point_rows[node.point]]
            for node, bonus in zip(self.nodes, extra, strict=True)
        ]

    # -- constraints
    def _build(self) -> None:
        ctx, fleet, nodes = self.ctx, self.fleet, self.nodes
        routing, manager = self.routing, self.manager
        solver = routing.solver()
        matrix = ctx.matrix
        settings = ctx.request.settings

        # Arc costs per vehicle (vehicles with the same cost profile share one matrix).
        lost = self._lost_revenue_cents()
        km_cost_rows: dict[float, dict[int, list[int]]] = {}
        cost_callbacks: dict[tuple[float, str, str], int] = {}
        for v, member in enumerate(fleet):
            vehicle = member.vehicle
            key = (vehicle.cost_per_km, vehicle.type, vehicle.department)
            if key not in cost_callbacks:
                rate = vehicle.cost_per_km
                if rate not in km_cost_rows:
                    km_cost_rows[rate] = self._point_rows(matrix.km_table, rate * CENTS_PER_EURO)
                tariff = self._tariff_key(vehicle)
                extra = [by_tariff.get(tariff, 0) for by_tariff in lost]
                cost_callbacks[key] = routing.RegisterTransitMatrix(self._node_rows(km_cost_rows[rate], extra))
            routing.SetArcCostEvaluatorOfVehicle(cost_callbacks[key], v)

        time_rows = self._node_rows(self._point_rows(matrix.minutes_table, 1), [node.service_min for node in nodes])
        meters_by_point = self._point_rows(matrix.km_table, METERS_PER_KM)
        self._meter_rows = [meters_by_point[node.point] for node in nodes]

        routing.AddDimension(routing.RegisterTransitMatrix(time_rows), HORIZON_MIN, HORIZON_MIN, False, "Time")
        time_dim = routing.GetDimensionOrDie("Time")
        routing.AddDimension(routing.RegisterTransitMatrix(self._meter_rows), 0, MAX_ROUTE_METERS, True, "Distance")
        distance_dim = routing.GetDimensionOrDie("Distance")
        routing.AddDimensionWithVehicleCapacity(
            routing.RegisterUnaryTransitVector([node.seats for node in nodes]),
            0,
            [member.vehicle.capacity for member in fleet],
            True,
            "Seats",
        )
        seats_dim = routing.GetDimensionOrDie("Seats")
        routing.AddDimensionWithVehicleCapacity(
            routing.RegisterUnaryTransitVector([node.exclusive for node in nodes]),
            0,
            [EXCLUSIVE_WEIGHT] * len(fleet),
            True,
            "Exclusive",
        )

        for v, member in enumerate(fleet):
            for index in (routing.Start(v), routing.End(v)):
                time_dim.CumulVar(index).SetRange(member.shift.open, member.shift.close)
            per_minute = round(member.vehicle.cost_per_hour * CENTS_PER_EURO / 60)
            time_dim.SetSpanCostCoefficientForVehicle(per_minute, v)
            routing.AddVariableMaximizedByFinalizer(time_dim.CumulVar(routing.Start(v)))
            routing.AddVariableMinimizedByFinalizer(time_dim.CumulVar(routing.End(v)))

        detour_allowance_m = round(min(settings.max_detour_km_per_extra_patient, settings.max_detour_km_total) * METERS_PER_KM)
        for pair_index, (trip, candidates) in enumerate(self.routable):
            p_node, d_node = self.trip_nodes[trip.id]
            pickup, delivery = manager.NodeToIndex(p_node), manager.NodeToIndex(d_node)
            routing.AddPickupAndDelivery(pickup, delivery)
            # Also enforced by the pickup-and-delivery filter; cheap to propagate (no cumul involved).
            solver.Add(routing.VehicleVar(pickup) == routing.VehicleVar(delivery))
            solver.Add(routing.ActiveVar(pickup) == routing.ActiveVar(delivery))
            if len(candidates) < len(fleet):
                _allow_vehicles(routing, pickup, candidates)
                _allow_vehicles(routing, delivery, candidates)
            for index, node in ((pickup, nodes[p_node]), (delivery, nodes[d_node])):
                time_dim.CumulVar(index).SetRange(node.window.open, node.window.close)
            penalty = round((settings.unassigned_penalty + self.best_revenue(trip, candidates)) * CENTS_PER_EURO)
            if trip.locked_vehicle_id is not None:
                penalty *= LOCKED_PENALTY_FACTOR
            self.drop_penalty[trip.id] = penalty
            routing.AddDisjunction([pickup], penalty)
            routing.AddDisjunction([delivery], 0)
            if trip.shareable and any(fleet[v].vehicle.capacity > 1 for v in candidates):
                # Same rounding as the distance dimension.
                self.detour_limits_m[trip.id] = self._meter_rows[p_node][d_node] + detour_allowance_m
                self._limit_ride(distance_dim, pair_index, self.detour_limits_m[trip.id])

        for v, break_nodes in self.break_nodes.items():
            indices = [manager.NodeToIndex(n) for n in break_nodes]
            for index, n in zip(indices, break_nodes, strict=True):
                _allow_vehicles(routing, index, [v])
                seats_dim.CumulVar(index).SetRange(0, 0)
                time_dim.CumulVar(index).SetRange(nodes[n].window.open, nodes[n].window.close)
            routing.AddDisjunction(indices, BREAK_PENALTY)

    def _limit_ride(self, distance_dim: pywrapcp.RoutingDimension, pair_index: int, limit_m: int) -> None:
        """Distance cumul of the delivery minus the pickup's <= limit_m (checked by the routing filters)."""

        def limit(_pickup_alternative: int, _delivery_alternative: int) -> int:
            return limit_m

        self._limit_functions.append(limit)
        distance_dim.SetPickupToDeliveryLimitFunctionForPair(limit, pair_index)

    # -- search
    def _params(self, seconds: float, *, first_solution_only: bool = False) -> routing_parameters_pb2.RoutingSearchParameters:
        params = pywrapcp.DefaultRoutingSearchParameters()
        params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
        params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        params.time_limit.FromMilliseconds(max(1, round(seconds * 1000)))
        if first_solution_only:
            params.solution_limit = 1
        return params

    def search(self, time_limit_sec: float) -> pywrapcp.Assignment | None:
        """First solution, break repair, guided local search (see module docstring), all within
        `time_limit_sec` (the first solution may use FIRST_SOLUTION_GRACE_SEC more); None when no
        plan was found."""
        started = time.monotonic()
        deadline = started + time_limit_sec
        # The routing limit set here also bounds the restore of the repaired plan below: the grace
        # keeps it alive for the repair when the first solution ends near the budget.
        first_limit = time_limit_sec + FIRST_SOLUTION_GRACE_SEC
        first = self.routing.SolveWithParameters(self._params(first_limit, first_solution_only=True))
        self.search_status = _status_name(self.routing)
        built = time.monotonic()
        if first is None:
            logger.info("solver: no first solution after %.1f s (%s)", built - started, self.search_status)
            return None
        if built > deadline:
            logger.warning("solver: first solution took %.1f s, over the %s s budget", built - started, time_limit_sec)
        with_breaks = self._with_all_breaks(first)
        start = first if with_breaks is None else with_breaks
        repaired = time.monotonic()
        logger.info(
            "solver: first solution %.2f s (%d trips placed), break repair %.2f s (%d trips kept)",
            built - started,
            self._placed(first),
            repaired - built,
            self._placed(start),
        )
        remaining = deadline - repaired
        if remaining < MIN_LOCAL_SEARCH_SEC:
            return start
        best = self.routing.SolveFromAssignmentWithParameters(start, self._params(remaining))
        if best is None:
            return start
        self.search_status = _status_name(self.routing)
        logger.info(
            "solver: local search %.2f s (%d trips placed) -> %s", time.monotonic() - repaired, self._placed(best), self.search_status
        )
        return best

    def _routes(self, solution: pywrapcp.Assignment) -> list[list[int]]:
        """Visited indices (depots excluded) of every vehicle."""
        routing = self.routing
        routes: list[list[int]] = []
        for v in range(len(self.fleet)):
            sequence: list[int] = []
            index = solution.Value(routing.NextVar(routing.Start(v)))
            while not routing.IsEnd(index):
                sequence.append(index)
                index = solution.Value(routing.NextVar(index))
            routes.append(sequence)
        return routes

    def _placed(self, solution: pywrapcp.Assignment) -> int:
        """Number of trips served by the solution."""
        return sum(1 for route in self._routes(solution) for index in route if self.node_at(index).role is Role.PICKUP)

    # -- break repair
    def _with_all_breaks(self, solution: pywrapcp.Assignment) -> pywrapcp.Assignment | None:
        """The solution with a break for every vehicle that needs one; None if the routing model
        rejects the repaired plan (the local search then inserts the missing breaks itself)."""
        routes = self._routes(solution)
        missing = [v for v in self.break_nodes if not any(self.node_at(index).role is Role.BREAK for index in routes[v])]
        if not missing:
            return solution
        time_dim = self.routing.GetDimensionOrDie("Time")
        cumuls = {index: solution.Value(time_dim.CumulVar(index)) for route in routes for index in route}
        for v in missing:
            routes[v] = self._fit_break(routes[v], v, cumuls)
        repaired = self.routing.ReadAssignmentFromRoutes(routes, True)
        if repaired is None:
            logger.warning("solver: break repair of %d vehicle(s) rejected by the routing model", len(missing))
        return repaired

    def _fit_break(self, route: Sequence[int], v: int, cumuls: dict[int, int]) -> list[int]:
        """Route of vehicle v with a break site inserted, dropping trips only when needed.

        If no trip has to go, the break takes the cheapest feasible empty position. Otherwise the
        cheapest trip whose removal alone makes room is dropped; failing that, the trip riding
        through the break window the most is dropped and the search goes on.
        A break goes where the vehicle is empty, so it changes neither loads nor rides; the only
        rule it can break is timing, checked exactly by _time_feasible.
        """
        sequence = list(route)
        while True:
            fitted = self._with_break(sequence, v)
            if fitted is not None:
                return fitted
            pickups = [index for index in sequence if self.node_at(index).role is Role.PICKUP]
            trips = [trip for trip in (self.node_at(index).trip for index in pickups) if trip is not None]
            if not trips:
                return [self.manager.NodeToIndex(self.break_nodes[v][0])]
            for trip in sorted(trips, key=lambda t: self.drop_penalty[t.id]):
                fitted = self._with_break(self._without_trips(sequence, {trip.id}), v)
                if fitted is not None:
                    return fitted
            sequence = self._without_trips(sequence, {self._trip_in_the_way(pickups, v, cumuls).id})

    def _with_break(self, sequence: Sequence[int], v: int) -> list[int] | None:
        """Cheapest time-feasible insertion of a break site of vehicle v, None if there is none."""
        return next((candidate for candidate in self._break_insertions(sequence, v) if self._time_feasible(v, candidate)), None)

    def _break_insertions(self, sequence: Sequence[int], v: int) -> Iterator[list[int]]:
        """Sequences with one break site inserted where the vehicle is empty, least extra km first."""
        matrix = self.ctx.matrix
        depot = self.nodes[v].point
        empty_positions: list[int] = [0]
        load = 0
        for position, index in enumerate(sequence, start=1):
            load += self.node_at(index).seats
            if load == 0:
                empty_positions.append(position)
        options: list[tuple[float, int, int]] = []
        for position in empty_positions:
            before = self.node_at(sequence[position - 1]).point if position > 0 else depot
            after = self.node_at(sequence[position]).point if position < len(sequence) else depot
            for n in self.break_nodes[v]:
                site = self.nodes[n].point
                extra = matrix.km_by_index(before, site) + matrix.km_by_index(site, after) - matrix.km_by_index(before, after)
                options.append((extra, position, self.manager.NodeToIndex(n)))
        options.sort()
        for _, position, index in options:
            yield [*sequence[:position], index, *sequence[position:]]

    def _time_feasible(self, v: int, sequence: Sequence[int]) -> bool:
        """Exact time-window and shift check of one route (earliest service starts)."""
        matrix = self.ctx.matrix
        shift = self.fleet[v].shift
        previous = self.nodes[v]
        clock = shift.open
        for index in sequence:
            node = self.node_at(index)
            clock = max(clock + previous.service_min + matrix.minutes_by_index(previous.point, node.point), node.window.open)
            if clock > node.window.close:
                return False
            previous = node
        clock += previous.service_min + matrix.minutes_by_index(previous.point, self.nodes[v].point)
        return clock <= shift.close

    def _without_trips(self, sequence: Sequence[int], trip_ids: set[str]) -> list[int]:
        """Sequence without these trips, nor the shared rides that their removal makes too long.

        Removing stops shortens the rides through them when distances obey the triangle
        inequality; a road matrix (OSRM) may not, hence the check.
        """
        removed = set(trip_ids)
        while True:
            kept = [index for index in sequence if (trip := self.node_at(index).trip) is None or trip.id not in removed]
            breaches = self._detour_breaches(kept)
            if not breaches:
                return kept
            removed |= breaches

    def _detour_breaches(self, sequence: Sequence[int]) -> set[str]:
        """Shareable trips of the sequence whose ride is longer than their detour limit."""
        riding: dict[str, int] = {}
        """Meters driven since the pickup, per trip on board."""
        breaches: set[str] = set()
        previous: int | None = None
        for index in sequence:
            n = self.manager.IndexToNode(index)
            if previous is not None:
                step = self._meter_rows[previous][n]
                for trip_id in riding:
                    riding[trip_id] += step
            previous = n
            node = self.nodes[n]
            if node.trip is None:
                continue
            if node.role is Role.PICKUP:
                riding[node.trip.id] = 0
            elif node.role is Role.DELIVERY:
                ride = riding.pop(node.trip.id, 0)
                limit = self.detour_limits_m.get(node.trip.id)
                if limit is not None and ride > limit:
                    breaches.add(node.trip.id)
        return breaches

    def _trip_in_the_way(self, pickups: Sequence[int], v: int, cumuls: dict[int, int]) -> Trip:
        """Trip whose ride overlaps the break window the most (first-solution times)."""
        window = self.fleet[v].breaks.window or FREE_WINDOW
        trips = [trip for trip in (self.node_at(pickup).trip for pickup in pickups) if trip is not None]

        def overlap(trip: Trip) -> int:
            pickup_node, delivery_node = self.trip_nodes[trip.id]
            begin = cumuls.get(self.manager.NodeToIndex(pickup_node), window.open)
            end = cumuls.get(self.manager.NodeToIndex(delivery_node), window.open)
            return min(end, window.close) - max(begin, window.open)

        return max(reversed(trips), key=overlap)

    # -- result
    def sequences(self, solution: pywrapcp.Assignment) -> dict[str, list[StopRef]]:
        result: dict[str, list[StopRef]] = {}
        for v, route in enumerate(self._routes(solution)):
            refs: list[StopRef] = []
            for index in route:
                node = self.node_at(index)
                if node.trip is not None and node.role is Role.PICKUP:
                    refs.append(StopRef(trip_id=node.trip.id, kind="PICKUP"))
                elif node.trip is not None and node.role is Role.DELIVERY:
                    refs.append(StopRef(trip_id=node.trip.id, kind="DROPOFF"))
            if refs:
                result[self.fleet[v].vehicle.id] = refs
        return result


def solve(ctx: PlanContext) -> SolveOutcome:
    """Routes of the day: stop sequences per vehicle and a reason for every unassigned trip."""
    fleet, warnings = usable_fleet(ctx)
    unassigned: dict[str, str] = {}
    routable: list[tuple[Trip, list[int]]] = []
    for trip in ctx.request.trips:
        candidates, reason = screen_trip(ctx, trip, fleet)
        if reason is not None:
            unassigned[trip.id] = reason
        else:
            routable.append((trip, candidates))

    if not routable:
        return SolveOutcome({}, unassigned, "OK", "NO_TRIP_TO_ROUTE", None, warnings)

    build_started = time.monotonic()
    model = _DayModel(ctx, fleet, routable)
    logger.info(
        "solver: model of %d trips, %d vehicles, %d nodes built in %.2f s",
        len(routable),
        len(fleet),
        len(model.nodes),
        time.monotonic() - build_started,
    )
    time_limit_sec = ctx.request.settings.time_limit_sec
    solution = model.search(time_limit_sec)
    status_name = model.search_status
    if solution is None:
        for trip, _ in routable:
            unassigned[trip.id] = REASON_NO_SOLUTION
        return SolveOutcome({}, unassigned, "NO_SOLUTION", status_name, None, warnings)

    sequences = model.sequences(solution)
    served = {ref.trip_id for refs in sequences.values() for ref in refs}
    dropped = [trip for trip, _ in routable if trip.id not in served]
    cut_short = search_cut_short(status_name)
    for trip in dropped:
        unassigned[trip.id] = REASON_DROPPED_TIME_LIMIT if cut_short else REASON_DROPPED
    if dropped and cut_short:
        warnings.append(time_limit_warning(time_limit_sec, len(dropped), len(ctx.request.trips)))
    return SolveOutcome(sequences, unassigned, "OK", status_name, float(solution.ObjectiveValue()), warnings)


def search_cut_short(status_name: str) -> bool:
    """True when the time limit stopped the search before it reached a local optimum.

    Guided local search always runs until the limit: ROUTING_SUCCESS then means it reached at
    least one local optimum (no single move could place another trip or lower the cost), while
    ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED means it was still improving the plan, or
    that no time was left for it after the first solution.
    """
    return status_name not in SEARCH_COMPLETE_STATUSES


def recommended_time_limit_sec(trip_count: int) -> int:
    """Budget for a day of `trip_count` trips: max(10 s, 1 s per 8 trips).

    Busy-day benchmark (160 trips, 16 vehicles with breaks, haversine matrix, see
    tests/test_solver_quality.py): a first solution takes about 1.5 s and the local search
    keeps improving the plan for 15 to 20 s.
    """
    return max(MIN_RECOMMENDED_SEC, math.ceil(trip_count / TRIPS_PER_RECOMMENDED_SEC))


def time_limit_warning(time_limit_sec: int, dropped: int, trip_count: int) -> str:
    """French warning when the search was cut short with trips left unplaced."""
    recommended = recommended_time_limit_sec(trip_count)
    advice = (
        f"un temps de calcul plus long (environ {recommended} s pour {trip_count} courses) peut en placer davantage"
        if recommended > time_limit_sec
        else "un temps de calcul plus long peut en placer davantage"
    )
    return f"Recherche interrompue par la limite de {time_limit_sec} s : {dropped} course(s) non placée(s) ; {advice}"
