"""OR-Tools model of a planning day: pickup and delivery with time windows (PDPTW).

Nodes
- one depot node per vehicle (start and end of its route);
- two nodes per trip: pickup and delivery (AddPickupAndDelivery, same vehicle, pickup first,
  both performed or both dropped);
- driver break sites of a vehicle whose break may fall inside its working time
  (BreakMode.NODE): its depot, the facilities of the trips it may serve and the homes where its
  lunchtime returns end when no other site is reachable in time. Exactly one is visited
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
   in Python (milliseconds).
3. Reinsertion: every trip left out (by the repair or by the first solution) goes back at its
   cheapest feasible position, trips with the fewest options first (regret insertion), with the
   same exact checks plus seats, exclusive rides and an empty vehicle at the break; the break
   moves when the trip only fits without it. The local search alone needed 5 to more than 120 s
   to win back the trips the repair drops; this takes milliseconds. The routing model then
   confirms the whole plan once.
4. Second start, built in Python: the breaks alone, then every trip by the same regret insertion.
   It respects the breaks from the start: on the seed days it serves more trips than steps 1-3
   (56 of 56 against 55 on 2026-11-05), on the 160-trip busy day fewer (118 against 129). The
   start with the lower objective is kept.
5. GUIDED_LOCAL_SEARCH on the remaining budget, from a plan where every break is performed:
   dropping a break would cost more than all the trips, so the best plan keeps them.
If the first solution fails (ROUTING_FAIL_TIMEOUT: the time limit ran out before the heuristic
produced anything, as on an overloaded machine), the plan of step 4 is built, then the local search
starts from it (from the breaks alone, always feasible, if the routing model rejects it); the two
share the rest of the budget, at least FALLBACK_SEARCH_SEC, half each. A plan, possibly with trips
left out, is returned whenever the model is feasible; its trips left out get the time-limit reason
(a re-run may place them), with WARNING_FIRST_SOLUTION_FAILED.

Determinism: nodes, candidates and every Python step iterate lists and insertion-ordered dicts
(never sets), so the model and, under a solution limit, the plan do not depend on PYTHONHASHSEED.
Only the wall-clock time limit (and the 100 ms LNS sub-search limit of OR-Tools) can make two runs
differ.
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
FALLBACK_SEARCH_SEC = 5
"""Least time of the fallback when the first solution failed, in all: half for the insertion from
the breaks (_built_from_breaks), half for the local search from that plan (see
_search_without_first_solution). The response then comes at most FIRST_SOLUTION_GRACE_SEC +
FALLBACK_SEARCH_SEC after the budget."""
MAX_BREAK_MOVES = 30
"""Positions tried, cheapest first, when a trip only fits once the vehicle's break moves."""
RESTORE_MARGIN_SEC = 1
"""Time kept, before the routing limit of the first solution runs out, to restore the repaired
plan (ReadAssignmentFromRoutes runs under that limit and fails once it is over)."""

REASON_DROPPED = "Pas de place dans les tournées : conflit d'horaires, de capacité ou de pause avec les autres courses"
REASON_DROPPED_TIME_LIMIT = (
    "Non placée dans le temps de calcul imparti : augmenter le temps de calcul (Paramètres) ou placer la course à la main"
)
REASON_NO_SOLUTION = "Aucune solution trouvée dans le temps de calcul imparti"
WARNING_FIRST_SOLUTION_FAILED = (
    "Construction initiale des tournées interrompue par la limite de temps (serveur chargé ?) : "
    "planning construit par une méthode de secours, relancer l'optimisation peut placer davantage de courses"
)

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
        self.first_solution_failed = False
        """True when the first solution failed: the plan then comes from the fallback (insertion
        from the breaks, then local search; see _search_without_first_solution)."""
        self._lost_cents: list[dict[tuple[str, str], int]] = []
        """Per pickup node: revenue lost (cents) with each candidate tariff (see _lost_revenue_cents)."""
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
        """Depot first, then the facilities of the trips this vehicle may serve, nearest first, then
        the homes needed by its lunchtime returns (_home_break_sites)."""
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
        return [*sites, *self._home_break_sites(v, member, window, duration, sites)]

    def _home_break_sites(self, v: int, member: FleetVehicle, window: Window, duration: int, sites: Sequence[int]) -> list[int]:
        """Homes where a RETURN trip of this vehicle can end inside the break window and from which,
        the dropoff ending at its latest, no other site is reachable before the latest break start.

        Without them, a lunchtime return far from the depot and from every facility (Gap -> Sisteron
        at noon) left no room for the break, although the driver can rest right there (the plan
        recomputed by schedule.py does). Only the homes that are needed: each one adds a node.
        """
        matrix = self.ctx.matrix
        settings = self.ctx.request.settings
        needed: list[tuple[int, int]] = []
        for trip, candidates in self.routable:
            home = self._point(trip.dropoff)
            if v not in candidates or trip.direction != "RETURN" or home in sites or any(home == h for _, h in needed):
                continue
            pickup = self.ctx.windows[trip.id].pickup
            ride = settings.pickup_service_min + matrix.minutes(trip.pickup, trip.dropoff) + settings.dropoff_service_min
            earliest_end, latest_end = pickup.open + ride, pickup.close + ride
            if earliest_end > window.close or latest_end < window.open:
                continue
            overshoot = latest_end + min(matrix.minutes_by_index(home, site) for site in sites) - window.close
            back = max(earliest_end, window.open) + duration + matrix.minutes_by_index(home, sites[0])
            if overshoot > 0 and back <= member.shift.close:
                needed.append((overshoot, home))
        needed.sort(key=lambda item: -item[0])  # stable: most needed first, then request order
        return [home for _, home in needed[:MAX_BREAK_SITES]]

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
        lost = self._lost_cents = self._lost_revenue_cents()
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
        """First solution, break repair, reinsertion, second start, guided local search (see module
        docstring), all within `time_limit_sec` (the first solution and the repair may use
        FIRST_SOLUTION_GRACE_SEC more, the fallback after a failed first solution
        FALLBACK_SEARCH_SEC); None when no plan was found."""
        started = time.monotonic()
        deadline = started + time_limit_sec
        # The routing limit set here also bounds the restore of the repaired plan below: the grace
        # keeps it alive for the repair when the first solution ends near the budget.
        first_limit = time_limit_sec + FIRST_SOLUTION_GRACE_SEC
        first = self.routing.SolveWithParameters(self._params(first_limit, first_solution_only=True))
        self.search_status = _status_name(self.routing)
        built = time.monotonic()
        if first is None:
            logger.warning("solver: no first solution after %.1f s (%s)", built - started, self.search_status)
            self.first_solution_failed = True
            return self._search_without_first_solution(deadline)
        if built > deadline:
            logger.warning("solver: first solution took %.1f s, over the %s s budget", built - started, time_limit_sec)
        # Both restores below run under the routing limit of the first solution.
        restore_deadline = started + first_limit - RESTORE_MARGIN_SEC
        start, kept = self._repaired(first, restore_deadline)
        repaired = time.monotonic()
        logger.info(
            "solver: first solution %.2f s (%d trips placed), break repair %d trips kept, reinsertion %d trips placed (%.2f s)",
            built - started,
            self._placed(first),
            kept,
            self._placed(start),
            repaired - built,
        )
        if repaired < deadline:
            routes = self._built_from_breaks(min(deadline, restore_deadline))
            constructed = self.routing.ReadAssignmentFromRoutes(routes, True)
            if constructed is None:
                logger.warning("solver: plan built from the breaks rejected by the routing model")
            else:
                chosen = constructed.ObjectiveValue() < start.ObjectiveValue()
                logger.info(
                    "solver: insertion from the breaks %.2f s (%d trips placed), %s",
                    time.monotonic() - repaired,
                    self._placed_in(routes),
                    "kept as the start" if chosen else "first solution kept",
                )
                start = constructed if chosen else start
        remaining = deadline - time.monotonic()
        if remaining < MIN_LOCAL_SEARCH_SEC:
            return start
        return self._local_search(start, remaining)

    def _local_search(self, start: pywrapcp.Assignment, seconds: float) -> pywrapcp.Assignment | None:
        """Guided local search from `start`; `start` itself when the search returns nothing."""
        began = time.monotonic()
        best = self.routing.SolveFromAssignmentWithParameters(start, self._params(seconds))
        if best is None:
            return start
        self.search_status = _status_name(self.routing)
        logger.info("solver: local search %.2f s (%d trips placed) -> %s", time.monotonic() - began, self._placed(best), self.search_status)
        return best

    def _search_without_first_solution(self, deadline: float) -> pywrapcp.Assignment | None:
        """Search when the first solution failed: the rest of the budget, at least
        FALLBACK_SEARCH_SEC, half for the insertion from the breaks, half for the local search from
        it; from the breaks-only routes (always feasible) if the routing model rejects it.

        The failed solve closed the model and used up its routing limit, under which
        ReadAssignmentFromRoutes would fail: the start only sets the routes (RoutesToAssignment)
        and the search, with a fresh limit, restores it.
        """
        now = time.monotonic()
        end = max(deadline, now + FALLBACK_SEARCH_SEC)
        constructed = self._built_from_breaks(now + (end - now) / 2)
        for routes in (constructed, self._breaks_only_routes()):
            start = self.routing.solver().Assignment()
            if not self.routing.RoutesToAssignment(routes, True, True, start):
                continue
            best = self.routing.SolveFromAssignmentWithParameters(start, self._params(max(end - time.monotonic(), MIN_LOCAL_SEARCH_SEC)))
            self.search_status = _status_name(self.routing)
            if best is not None:
                logger.info(
                    "solver: local search from %d trips inserted after the breaks: %d trips placed -> %s",
                    self._placed_in(routes),
                    self._placed(best),
                    self.search_status,
                )
                return best
        logger.warning("solver: no start accepted by the routing model (%s)", self.search_status)
        return None

    def _breaks_only_routes(self) -> list[list[int]]:
        """Each vehicle's break at its cheapest feasible site (the depot) and nothing else."""
        return [self._with_break([], v) or [] if v in self.break_nodes else [] for v in range(len(self.fleet))]

    def _built_from_breaks(self, deadline: float) -> list[list[int]]:
        """Routes built in Python: the breaks alone, then every trip by regret insertion (breaks
        moved when needed, see _cheapest_insertion), until the deadline."""
        routes = self._breaks_only_routes()
        self._insert_left_out(routes, deadline)
        return routes

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
        return self._placed_in(self._routes(solution))

    def _placed_in(self, routes: Sequence[Sequence[int]]) -> int:
        return sum(1 for route in routes for index in route if self.node_at(index).role is Role.PICKUP)

    # -- break repair
    def _repaired(self, solution: pywrapcp.Assignment, insertion_deadline: float) -> tuple[pywrapcp.Assignment, int]:
        """The solution with a break for every vehicle that needs one and the trips left out
        reinserted, and the number of trips kept by the break repair alone. The solution as it is
        if the routing model rejects the result (the local search then inserts the missing breaks
        itself)."""
        routes = self._routes(solution)
        missing = [v for v in self.break_nodes if not any(self.node_at(index).role is Role.BREAK for index in routes[v])]
        if missing:
            time_dim = self.routing.GetDimensionOrDie("Time")
            cumuls = {index: solution.Value(time_dim.CumulVar(index)) for route in routes for index in route}
            for v in missing:
                routes[v] = self._fit_break(routes[v], v, cumuls)
        kept = self._placed_in(routes)
        inserted = self._insert_left_out(routes, insertion_deadline)
        if not missing and not inserted:
            return solution, kept
        repaired = self.routing.ReadAssignmentFromRoutes(routes, True)
        if repaired is None:
            logger.warning(
                "solver: repaired plan (%d break(s), %d trip(s) reinserted) rejected by the routing model", len(missing), inserted
            )
            return solution, kept
        return repaired, kept

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

    # -- reinsertion of the trips left out
    def _insert_left_out(self, routes: list[list[int]], deadline: float) -> int:
        """Put the trips missing from `routes` (changed in place) back at their cheapest feasible
        position, until none fits or the deadline passes; returns the number inserted.

        Regret insertion: the trip with the largest gap between its best and second-best vehicle
        goes first (a trip with a single option first of all), so that the trips with few options
        are not crowded out by those that fit anywhere. An insertion makes a route tighter (only a
        moved break can free a slot): a trip without any option is not retried, and after an
        insertion only the options in the changed route are recomputed.
        """
        placed = {self.node_at(index).trip.id for route in routes for index in route if self.node_at(index).trip is not None}
        options: dict[str, dict[int, tuple[float, list[int]]]] = {}
        for trip, candidates in self.routable:
            if time.monotonic() >= deadline:
                return 0
            if trip.id in placed:
                continue
            by_vehicle = {v: best for v in candidates if (best := self._cheapest_insertion(routes[v], v, trip)) is not None}
            if by_vehicle:
                options[trip.id] = by_vehicle
        inserted = 0
        while options and time.monotonic() < deadline:
            trip_id, v = self._next_insertion(options)
            routes[v] = options.pop(trip_id)[v][1]
            inserted += 1
            for other_id, by_vehicle in list(options.items()):
                if v not in by_vehicle:
                    continue
                best = self._cheapest_insertion(routes[v], v, self.ctx.trips[other_id])
                if best is not None:
                    by_vehicle[v] = best
                    continue
                del by_vehicle[v]
                if not by_vehicle:
                    del options[other_id]
        return inserted

    @staticmethod
    def _next_insertion(options: dict[str, dict[int, tuple[float, list[int]]]]) -> tuple[str, int]:
        """(trip, vehicle) of the next insertion: largest regret, then cheapest, then first listed."""
        chosen: tuple[float, float, str, int] | None = None
        for trip_id, by_vehicle in options.items():
            costs = sorted((cost, v) for v, (cost, _) in by_vehicle.items())
            regret = costs[1][0] - costs[0][0] if len(costs) > 1 else math.inf
            if chosen is None or (regret, -costs[0][0]) > (chosen[0], chosen[1]):
                chosen = (regret, -costs[0][0], trip_id, costs[0][1])
        assert chosen is not None
        return chosen[2], chosen[3]

    def _cheapest_insertion(self, route: Sequence[int], v: int, trip: Trip) -> tuple[float, list[int]] | None:
        """Cheapest feasible route of vehicle v with the trip's pickup and delivery inserted, and
        its extra cost (cents: km and driving minutes added, revenue lost against the best tariff),
        None when the trip fits nowhere.

        When the trip fits nowhere around the vehicle's break, the break may move: the trip goes
        into the route without the break, which then takes its cheapest feasible empty position
        again (_with_break). The first solution and the repair place breaks with no regard for the
        trips still to come; lunchtime returns often need exactly the slot the break holds.
        """
        sequence = self._first_feasible(v, route, self._insertion_positions(route, v, trip), trip)
        if sequence is not None:
            return sequence
        held = [k for k, index in enumerate(route) if self.node_at(index).role is Role.BREAK]
        if not held:
            return None
        k = held[0]
        bare = [*route[:k], *route[k + 1 :]]
        current = self._stop_cost(v, route, k)
        for cost, i, j in self._insertion_positions(bare, v, trip)[:MAX_BREAK_MOVES]:
            moved = self._with_break(self._inserted(bare, trip, i, j), v)
            if moved is not None and not self._detour_breaches(moved):
                where = next(n for n, index in enumerate(moved) if self.node_at(index).role is Role.BREAK)
                return cost + self._stop_cost(v, moved, where) - current, moved
        return None

    def _first_feasible(
        self, v: int, route: Sequence[int], positions: Sequence[tuple[float, int, int]], trip: Trip
    ) -> tuple[float, list[int]] | None:
        """First screened position (cheapest first) that passes the full time and detour checks."""
        for cost, i, j in positions:
            sequence = self._inserted(route, trip, i, j)
            if self._time_feasible(v, sequence) and not self._detour_breaches(sequence):
                return cost, sequence
        return None

    def _inserted(self, route: Sequence[int], trip: Trip, i: int, j: int) -> list[int]:
        """The route with the trip's pickup before stop i and its delivery before stop j (j >= i)."""
        p_node, d_node = self.trip_nodes[trip.id]
        return [*route[:i], self.manager.NodeToIndex(p_node), *route[i:j], self.manager.NodeToIndex(d_node), *route[j:]]

    def _stop_cost(self, v: int, route: Sequence[int], k: int) -> float:
        """Cost (cents) of the detour through stop k of the route of vehicle v."""
        depot = self.nodes[v]
        before = self.node_at(route[k - 1]) if k else depot
        after = self.node_at(route[k + 1]) if k + 1 < len(route) else depot
        return self._detour_cost(v, before, self.node_at(route[k]), after)

    def _detour_cost(self, v: int, a: Node, b: Node, c: Node) -> float:
        """Cost (cents) for vehicle v of driving a -> b -> c instead of a -> c: km and minutes."""
        matrix = self.ctx.matrix
        vehicle = self.fleet[v].vehicle
        km = matrix.km_by_index(a.point, b.point) + matrix.km_by_index(b.point, c.point) - matrix.km_by_index(a.point, c.point)
        minutes = (
            matrix.minutes_by_index(a.point, b.point) + matrix.minutes_by_index(b.point, c.point) - matrix.minutes_by_index(a.point, c.point)
        )
        return km * vehicle.cost_per_km * CENTS_PER_EURO + minutes * vehicle.cost_per_hour * CENTS_PER_EURO / 60

    def _insertion_positions(self, route: Sequence[int], v: int, trip: Trip) -> list[tuple[float, int, int]]:
        """(extra cost, pickup position i, delivery position j) of every position of the trip in
        the route of vehicle v that passes the screening, cheapest first.

        The screening is exact for times (earliest starts forward, latest starts that keep the
        rest of the route on time backward), seats, exclusive rides, the empty vehicle at the break
        and the trip's own detour; only the rides of the other patients on board are left to the
        full check (_first_feasible).
        """
        matrix = self.ctx.matrix
        member = self.fleet[v]
        depot = self.nodes[v]
        p_node, d_node = self.trip_nodes[trip.id]
        pickup, delivery = self.nodes[p_node], self.nodes[d_node]
        stops = [self.node_at(index) for index in route]
        count = len(stops)
        capacity = member.vehicle.capacity

        earliest: list[int] = []
        seats: list[int] = []
        exclusive: list[int] = []
        clock, previous, load, alone = member.shift.open, depot, 0, 0
        for node in stops:
            clock = max(clock + previous.service_min + matrix.minutes_by_index(previous.point, node.point), node.window.open)
            load, alone = load + node.seats, alone + node.exclusive
            earliest.append(clock)
            seats.append(load)
            exclusive.append(alone)
            previous = node
        # Latest service start at each stop (arrival at the end depot last) keeping the rest on time.
        latest = [member.shift.close] * (count + 1)
        following = depot
        for k in reversed(range(count)):
            node = stops[k]
            latest[k] = min(node.window.close, latest[k + 1] - matrix.minutes_by_index(node.point, following.point) - node.service_min)
            following = node

        limit_m = self.detour_limits_m.get(trip.id)
        weight = pickup.exclusive
        base = self._lost_cents[p_node].get(self._tariff_key(member.vehicle), 0)

        def extra(a: Node, b: Node, c: Node) -> float:
            return self._detour_cost(v, a, b, c)

        positions: list[tuple[float, int, int]] = []
        for i in range(count + 1):
            before = stops[i - 1] if i else depot
            departure = earliest[i - 1] + before.service_min if i else member.shift.open
            if departure > pickup.window.close:
                break  # departures only get later along the route
            start_p = max(departure + matrix.minutes_by_index(before.point, pickup.point), pickup.window.open)
            if start_p > pickup.window.close:
                continue
            if (seats[i - 1] if i else 0) + pickup.seats > capacity or (exclusive[i - 1] if i else 0) + weight > EXCLUSIVE_WEIGHT:
                continue
            after_p = stops[i] if i < count else depot
            pickup_cost = extra(before, pickup, after_p)
            # Delivery right after `last` (the pickup, then each stop ridden through), before stop j.
            last, clock, ride = pickup, start_p, 0
            for j in range(i, count + 1):
                after = stops[j] if j < count else depot
                start_d = max(clock + last.service_min + matrix.minutes_by_index(last.point, delivery.point), delivery.window.open)
                on_time = start_d <= delivery.window.close and (
                    start_d + delivery.service_min + matrix.minutes_by_index(delivery.point, after.point) <= latest[j]
                )
                if on_time and (limit_m is None or ride + self._meters(last, delivery) <= limit_m):
                    cost = extra(pickup, delivery, after_p) if j == i else extra(last, delivery, after)
                    positions.append((base + pickup_cost + cost, i, j))
                if j == count:
                    break
                # Ride through stop j with the patient on board.
                node = stops[j]
                if node.role is Role.BREAK or seats[j] + pickup.seats > capacity or exclusive[j] + weight > EXCLUSIVE_WEIGHT:
                    break
                clock = max(clock + last.service_min + matrix.minutes_by_index(last.point, node.point), node.window.open)
                ride += self._meters(last, node)
                if clock > node.window.close or (limit_m is not None and ride > limit_m):
                    break
                last = node
        positions.sort()
        return positions

    def _meters(self, a: Node, b: Node) -> int:
        """Distance-dimension transit (meters, rounded like the model) between two nodes' places."""
        return round(self.ctx.matrix.km_by_index(a.point, b.point) * METERS_PER_KM)

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
    if model.first_solution_failed:
        warnings.append(WARNING_FIRST_SOLUTION_FAILED)

    sequences = model.sequences(solution)
    served = {ref.trip_id for refs in sequences.values() for ref in refs}
    dropped = [trip for trip, _ in routable if trip.id not in served]
    # After a failed first solution the plan comes from a shortened fallback search, and the
    # warning above says a re-run may place more: never tell the regulator there is no room.
    cut_short = model.first_solution_failed or search_cut_short(status_name)
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
