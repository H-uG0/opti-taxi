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
- driver break: the break sites form a disjunction whose penalty dominates every other cost;
- 6-hour routes for a vehicle without a legal break (span upper bound of the time dimension);
- time on board (direct drive + maxRideExtraMin) and wait on board in front of the facility:
  checked by the Python steps (insertion, repairs) on close times and by the final check
  (_DayModel.guarded) on the times schedule.py reports, as is the work time of the routes. The
  time on board was a pickup-to-delivery limit on the time dimension too, until OPT-08: on that
  dimension, whose slack is the waiting, the routing filters made the first solution of a busy day
  take 14 s instead of 1 s and held the local search back (journal).

Every rule of the model uses a routing primitive (dimension, pickup-to-delivery limit, vehicle
domain, disjunction) that the routing filters check at each insertion and local-search move. A
constraint posted on cumul variables with solver.Add() is only checked by propagation after the
filters accepted a move: with the detour and precedences written that way, the first solution of a
160-trip day took 6 to 10 s instead of 1.5 s.

Objective (UNITS_PER_CENT units per cent): km x costPerKm per vehicle; minutes x costPerHour / 60
on the route span; revenue lost against the best vehicle type for the trip on the arc leaving its
pickup (picks the vehicle type that earns most); dropping a trip costs unassignedPenalty + its best
revenue (twice that for a trip locked by the regulator); a patient whose outbound and return are
not both served costs unassignedPenalty more. Unused vehicles only carry their break (depot site,
no km), a constant. The shared-ride discount is not in the objective (not linear): it is applied
when the plan is recomputed.

Search (budget = settings.timeLimitSec, the model build included: see solve())
1. Starts built in Python first, each confirmed by the routing model at once
   (ReadAssignmentFromRoutes: after a solve that used up its routing limit, that restore fails):
   a. the plan in place (contract `initialRoutes`), when the web sends one, repaired to the rules
      of the request (_from_plan: trips that break a rule out, breaks in, trips left out
      reinserted as in step 4);
   b. the insertion from the breaks: the breaks alone, then every trip by the regret insertion of
      step 4. It respects the breaks from the start; it may run FIRST_SOLUTION_GRACE_SEC past the
      budget. It takes seconds where step 2 takes minutes on a large fleet: 5 s against 60 s on a
      120-vehicle, 300-trip day (tests/bench_fleet.py), whose 2 000 nodes (1 286 break sites) put
      the OR-Tools heuristic far past the 38 s the web sends. Before it came first, that day got
      an empty plan;
   c. when step 2 will run, the same insertion ordered by regret alone (no "other leg of a served
      patient first"): the two orders lead the local search to different plans, each the better
      one on two of the four demo days (journal, OPT-08).
2. First solution: PARALLEL_CHEAPEST_INSERTION, run to completion (stopped early, it leaves most
   trips unplaced), even FIRST_SOLUTION_GRACE_SEC past the budget. Break sites are inserted after
   the trips, so a busy vehicle may get none. Its time grows like the cube of the node count: when
   that law says it cannot finish, it is skipped and the cheapest start of step 1 is the plan, at
   once (solverStatus INSERTION; the local search gained 1 % of km in 10 min at that size).
3. Break repair: a vehicle left without a break gets one at the cheapest feasible empty position,
   removing the trips that ride through the break window if needed. Exact time and detour checks
   in Python (milliseconds).
4. Reinsertion: every trip left out (by the repair or by the first solution) goes back at its
   cheapest feasible position, trips with the fewest options first (regret insertion), with the
   same exact checks plus seats, exclusive rides and an empty vehicle at the break; the break
   moves when the trip only fits without it. The local search alone needed 5 to more than 120 s
   to win back the trips the repair drops; this takes milliseconds. The routing model then
   confirms the whole plan once.
5. GUIDED_LOCAL_SEARCH from every start for a short while (PROBE_SHARE of the time left, shared),
   then from the best plan found until the deadline (_portfolio). The local search seldom places
   a trip its start left out, and the cheapest start is not the one that ends best: on 2026-11-10
   of the demo, the first solution (57 trips) was cheaper than the insertion (56) and stayed at 57,
   where either insertion reaches 59. Every plan keeps its breaks: dropping one would cost more
   than all the trips.
If the first solution fails (ROUTING_FAIL_TIMEOUT: the time limit ran out before the heuristic
produced anything, as on an overloaded machine), the local search starts from the cheapest Python
start (from the breaks alone, always feasible, if the routing model rejected them all) for the rest
of the budget, at least FALLBACK_SEARCH_SEC. If the first solution ends cut short by its limit and
a Python start is cheaper, more time may help. A plan, possibly with trips left out, is returned
whenever the model is feasible; when it comes from a Python start for one of these reasons, its
trips left out get the time-limit reason (a re-run may place them), with
WARNING_FIRST_SOLUTION_FAILED.
After the search, the final check (guarded: trips breaking a rule out, then they and every trip
the search left out back where they fit) and the pair repair (restore_pairs) run on the plan, and on
the plan in place repaired when there is one, the routing model accepted it and the search returned
another plan, all within one budget (GUARD_SEC + PAIR_REPAIR_SEC): the one with the lower
plan_score is returned, so that re-optimizing a date never gives a plan worse than the one in place
under the same rules and the same objective. plan_score weighs like the objective (the penalty per
trip left out and per patient not served both ways, minus the margin as the response reports it):
one more trip served can be traded for one fewer half-served patient, the margin deciding. Last, a
trip still left out may take the place of a trip in its way that fits elsewhere (make_room, the time
the search left or MAKE_ROOM_SEC), and each trip left out gets a reason naming what keeps each
compatible vehicle from taking it (left_out_reason, REASON_SEC).

The plan in place is repaired at break sites that do not depend on the locks (_break_site_vehicles)
and include the places where its routes rest (_plan_break_sites): repairing a plan the optimizer
made, under the same rules and data, keeps every trip, also when « Placer les non affectées » locks
each of them on its vehicle (OPT-09).

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
from app.model import (
    FREE_WINDOW,
    HORIZON_MIN,
    MAX_WORK_WITHOUT_BREAK_MIN,
    MIN_LEGAL_BREAK_MIN,
    BreakMode,
    BreakPlan,
    Window,
    break_plan,
    effective_shift,
    is_compatible,
    same_day_pairs,
    service_minutes,
    work_limit_min,
)
from app.plan import plan_margin
from app.schedule import PlannedStop, RouteSchedule, schedule_route
from app.schemas import LatLng, PlanStatus, RoutePlan, StopRef, Trip, Vehicle
from app.traffic import stop_reference_minute

logger = logging.getLogger("optimizer.solver")

CENTS_PER_EURO = 100
TariffKey = tuple[str | None, bool]
"""(grid id, TPMR-fitted) of a vehicle: what a trip's estimated revenue depends on (Model._tariff_key)."""
UNITS_PER_CENT = 1000
"""Objective units per cent: the km cost of each vehicle goes per meter on the Distance dimension,
an integer coefficient that keeps a cost per km to the cent (0.32 EUR/km = 32 units per meter)."""
METERS_PER_KM = 1000
EXCLUSIVE_WEIGHT = 100
"""Exclusive-ride load of a non-shareable patient (vehicle limit); shareable patients weigh 1."""
MAX_BREAK_SITES = 12
BREAK_LEG_LOOKBACK_MIN = 120
"""How long before its window a break can still share a leg, in schedule.py, with a stop whose band
then times the drive: the 45 min wait allowed around a reference, plus the most two bands can differ
on a leg. Earlier, the vehicle arrives before the window opens and the band of that stop costs nothing.
Short enough not to slow the drive after a noon break by the morning peak."""
LOCKED_PENALTY_FACTOR = 2
MAX_ROUTE_METERS = 10_000_000
BREAK_PENALTY = 10**16
"""Cost (objective units, 10**11 EUR) of a vehicle without its break: more than any set of trips."""
MIN_LOCAL_SEARCH_SEC = 0.2
"""Below this remaining budget, the repaired first solution is returned as is."""
FIRST_SOLUTION_GRACE_SEC = 5
"""Extra time the first solution may take beyond the budget: interrupted, the insertion heuristic
leaves most trips unplaced (none of 160 with a 1 s budget). The web client waits the budget + 30 s."""
FALLBACK_SEARCH_SEC = 5
"""Least time of the local search from the insertion when the first solution failed (see
_search_without_first_solution). The search then ends at most 2 x FIRST_SOLUTION_GRACE_SEC +
FALLBACK_SEARCH_SEC after the budget (the Python starts and the first solution may each use the
grace), and the final passes take GUARD_SEC + PAIR_REPAIR_SEC + MAKE_ROOM_SEC + REASON_SEC more at
most (solve): 26 s, plus the matrix and the response, within the 30 s the web adds to the budget."""
MIN_SEARCH_SEC = 1.0
"""Least search budget once the model build is taken out of settings.timeLimitSec (see solve())."""
MAX_BREAK_MOVES = 30
"""Positions tried, cheapest first, when a trip only fits once the vehicle's break moves."""
RESTORE_MARGIN_SEC = 1
"""Time kept, before the routing limit of the first solution runs out, to restore the repaired
plan (ReadAssignmentFromRoutes runs under that limit and fails once it is over)."""
FIRST_SOLUTION_SEC_PER_NODE3 = 8e-9
"""Measured time law of the OR-Tools first solution: about 8e-9 x nodes^3 s (0.9 s for the 476
nodes of the busy day, 60 s for the 2 000 nodes of 120 vehicles and 300 trips; README)."""
GUARD_SEC = 5.0
"""Most time the final check of the scheduled routes (guarded) may spend reinserting trips."""
PAIR_REPAIR_SEC = 3.0
"""Most time the final pass that gives a half-served patient their other leg may take (restore_pairs).
With GUARD_SEC, the budget of every final pass after the search, those on the plan in place
included (solve)."""
MAKE_ROOM_SEC = 2.0
"""Least time of the last pass, where a trip left out takes the place of a trip that moves elsewhere
(make_room): it also gets whatever the search left of the budget."""
PAIR_REPAIR_SLACK_MIN = 90
"""A trip is in the way of a missing leg when its ride comes this close to the leg's reference minutes."""
STATUS_INSERTION = "INSERTION"
"""solverStatus of a plan built by the Python insertion alone (first solution skipped, see search)."""
PROBE_SHARE = 0.5
"""Share of the search time spent on a short guided local search from every start (_portfolio);
the rest goes on from the best plan they found."""
MIN_PROBE_SEC = 0.5
"""Shortest search from one start worth running: below it, only the cheapest start is searched."""

NBSP = "\u00a0"
# Before « ; », « ! », « ? » and inside « »: a narrow no-break space (as the web, lot UI-07).
NNBSP = "\u202f"
"""Non-breaking space, before « : » and « ; » in the reasons of the trips left out (French
typography: a narrow panel never starts a line with the punctuation)."""
REASON_DROPPED_PREFIX = "Pas de place dans les tournées pour le trajet de"
"""Start of the reason of a trip the search left out with no more time to help: what keeps each
compatible vehicle from taking it follows (_DayModel.left_out_reason)."""
REASON_DROPPED_DETAIL = "conflit d'horaires, de capacité ou de pause avec les autres courses"
"""What the reason of a trip left out says when there was no time left to tell what each vehicle does."""
REASON_SEC = 1.0
"""Most time spent telling, for the trips left out, what keeps each compatible vehicle from taking them."""
MAX_NAMED_VEHICLES = 3
"""Up to this many compatible vehicles, the reason of a trip left out names each one; above, it counts them."""
ALONE_TEXT = "ne peut pas l'assurer avec la pause de son chauffeur, même sans autre course"
"""What the reason says of a vehicle whose driver cannot take the trip and the break even in an
otherwise empty day."""
ALONE_ADVICE = "à confier à un confrère ou décaler la pause"
"""What the regulator can do when no compatible vehicle can take the trip with its driver's break."""
LEFT_OUT_KINDS: dict[str, tuple[str, str]] = {
    "free": ("{} a la place de la prendre (à placer à la main)", "{} ont la place de la prendre (à placer à la main)"),
    "busy": ("{} transporte d'autres patients", "{} transportent d'autres patients"),
    "share": (
        "{} ne peut pas la partager avec ses patients (détour ou horaires)",
        "{} ne peuvent pas la partager avec leurs patients (détour ou horaires)",
    ),
    "break": ("{} est bloqué par la pause de son chauffeur", "{} sont bloqués par la pause de leur chauffeur"),
    "tight": ("{} ne peut pas l'intercaler entre ses courses", "{} ne peuvent pas l'intercaler entre leurs courses"),
    "alone": (
        "{} ne peut pas l'assurer avec la pause de son chauffeur, même sans autre course",
        "{} ne peuvent pas l'assurer avec la pause de leur chauffeur, même sans autre course",
    ),
}
"""Singular and plural of each kind of obstacle counted in the reason of a trip left out
(_DayModel.left_out_reason, _DayModel._obstacle)."""
REASON_DROPPED_TIME_LIMIT = (
    "Non placée dans le temps de calcul imparti\u00a0: augmenter le temps de calcul (Paramètres) ou placer la course à la main"
)
REASON_NO_SOLUTION = "Aucune solution trouvée dans le temps de calcul imparti"
REASON_DROPPED_ON_BOARD = (
    "Pas de place dans les tournées sans dépasser le temps à bord ou l'attente au lieu de soins "
    "des patients transportés ensemble"
)
REASON_DROPPED_WORK_TIME = (
    "Pas de place dans les tournées sans dépasser 6\u00a0h de travail sans pause de 20\u00a0min "
    "(Code du travail, art. L. 3121-16)"
)
WARNING_FIRST_SOLUTION_FAILED = (
    "Construction initiale des tournées interrompue par la limite de temps (serveur chargé\u202f?)\u00a0: "
    "planning construit par une méthode de secours, relancer l'optimisation peut placer davantage de courses"
)

SEARCH_COMPLETE_STATUSES = frozenset({"ROUTING_SUCCESS", "ROUTING_OPTIMAL", STATUS_INSERTION})
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
    reference_min: int | None = None
    """Minute the stop is expected around (app/traffic.py), None for a depot."""


@dataclass(frozen=True)
class FleetVehicle:
    vehicle: Vehicle
    breaks: BreakPlan
    shift: Window
    work_limit: int | None = None
    """Longest route (minutes) without a legal break inside it, None when unlimited (model.work_limit_min)."""


@dataclass(frozen=True)
class _Start:
    """A starting plan of the guided local search, confirmed by the routing model."""

    label: str
    solution: pywrapcp.Assignment
    routes: list[list[int]]


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
            warnings.append(f"{vehicle_name(vehicle)} non utilisé\u00a0: sa pause ne peut pas être placée dans son horaire")
            continue
        shift = effective_shift(vehicle, plan)
        fleet.append(FleetVehicle(vehicle, plan, shift, work_limit_min(vehicle, plan, shift)))
    return fleet, warnings


def _reachable_alone(ctx: PlanContext, trip: Trip, member: FleetVehicle) -> bool:
    """Can the vehicle do this trip alone (depot -> pickup -> dropoff -> depot) within its shift?"""
    matrix, settings = ctx.matrix, ctx.request.settings
    windows = ctx.windows[trip.id]
    depot = member.vehicle.depot
    at_pickup, at_dropoff = stop_reference_minute(trip, "PICKUP", matrix), stop_reference_minute(trip, "DROPOFF", matrix)
    to_pickup, ride = matrix.leg(depot, trip.pickup, None, at_pickup), matrix.leg(trip.pickup, trip.dropoff, at_pickup, at_dropoff)
    to_depot = matrix.leg(trip.dropoff, depot, at_dropoff, None)
    pickup_service, dropoff_service = service_minutes(settings, trip, "PICKUP"), service_minutes(settings, trip, "DROPOFF")
    # Alone, an outbound pickup (free window) or a return dropoff (free window) absorbs any wait.
    if member.work_limit is not None and to_pickup + pickup_service + ride + dropoff_service + to_depot > member.work_limit:
        return False
    pickup_start = max(member.shift.open + to_pickup, windows.pickup.open)
    if pickup_start > windows.pickup.close:
        return False
    dropoff_start = max(pickup_start + pickup_service + ride, windows.dropoff.open)
    if dropoff_start > windows.dropoff.close:
        return False
    return dropoff_start + dropoff_service + to_depot <= member.shift.close


def screen_trip(ctx: PlanContext, trip: Trip, fleet: Sequence[FleetVehicle]) -> tuple[list[int], str | None]:
    """Fleet positions able to serve the trip, or a French reason why none can."""
    if trip.locked_vehicle_id is not None:
        locked = ctx.vehicles.get(trip.locked_vehicle_id)
        if locked is None:
            return [], f"Véhicule figé «\u202f{trip.locked_vehicle_id}\u202f» absent de la flotte du jour"
        if locked.type not in trip.allowed_vehicle_types:
            return [], (
                f"Véhicule figé {vehicle_name(locked)} d'un type non autorisé pour cette course "
                f"(autorisés\u00a0: {types_text(trip.allowed_vehicle_types)})"
            )
        if all(member.vehicle.id != locked.id for member in fleet):
            return [], f"Véhicule figé {vehicle_name(locked)} inutilisable\u00a0: sa pause ne tient pas dans son horaire"

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
        f"Horaires inatteignables ({when})\u00a0: aucun véhicule compatible ne peut assurer la course "
        "depuis son dépôt dans ses heures de service"
    )


def _middle(window: Window) -> int:
    """Reference minute of a break (app/traffic.py): the middle of its window."""
    return (window.open + window.close) // 2


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

    def __init__(
        self,
        ctx: PlanContext,
        fleet: Sequence[FleetVehicle],
        routable: Sequence[tuple[Trip, list[int]]],
        initial_routes: Sequence[RoutePlan] = (),
    ) -> None:
        self.ctx = ctx
        self.fleet = fleet
        self.routable = routable
        self.initial_routes = initial_routes
        """The plan in place sent by the web (contract `initialRoutes`), a start of the search."""
        self.warm_routes: list[list[int]] | None = None
        """The plan in place repaired (_from_plan), when there was one and the routing model accepted
        it: the plan returned never scores worse than it (solve, plan_score)."""
        self.start_label = ""
        """The start the plan comes from (logs, tests)."""
        self.nodes: list[Node] = []
        self.trip_nodes: dict[str, tuple[int, int]] = {}
        self.break_nodes: dict[int, list[int]] = {}
        """Break sites (node numbers) of each vehicle with a break node, its depot first."""
        self.detour_limits_m: dict[str, int] = {}
        """Longest allowed ride (meters) of each shareable trip."""
        self.ride_limits: dict[str, int] = {}
        """Longest time on board (minutes, end of the pickup to start of the dropoff) of each trip:
        the direct drive plus settings.maxRideExtraMin."""
        self.partner: dict[str, str] = {}
        """Same-day outbound <-> return of a patient, both routable (model.same_day_pairs)."""
        self.drop_penalty: dict[str, int] = {}
        """Objective cost (units) of leaving each trip unassigned."""
        self.coherence_penalty = 0
        """Extra cost (units) of a patient whose outbound or return alone is served."""
        self._candidates: dict[str, list[int]] = {trip.id: candidates for trip, candidates in routable}
        self._plan_by_vehicle: dict[str, RoutePlan] = {}
        """Route of each vehicle in the plan in place (the first one given, as _from_plan reads it)."""
        for plan in initial_routes:
            self._plan_by_vehicle.setdefault(plan.vehicle_id, plan)
        self._site_vehicles: dict[str, frozenset[int]] = self._break_site_vehicles()
        """Vehicles whose break sites may include each trip's places (_break_site_vehicles)."""
        self.cost_matrices = 0
        """Arc cost matrices registered (one per tariff of the fleet)."""
        self.search_status = "ROUTING_NOT_SOLVED"
        """Status of the last solver run (the routing status changes when an assignment is read)."""
        self.first_solution_failed = False
        """True when the plan comes from the insertion from the breaks because the first solution
        failed, or ran out of time with a costlier plan: more time may place more trips."""
        self.inserted_trips = 0
        """Trips placed by the insertion from the breaks, the first step of the search."""
        self.first_solution_skipped = False
        """True when the first solution was not run: the cube law said it could not finish in time."""
        self.insertion_cut_short = False
        """True when a reinsertion stopped at its deadline with trips still to place."""
        self._exact_checks = False
        """While set (final check, _guarded), every insertion is also timed by schedule.py."""
        self._alone_routes: dict[int, list[int]] = {}
        """Each vehicle's route with its break alone, once computed (left_out_reason)."""
        self._lost_cents: list[dict[TariffKey, int]] = []
        """Per pickup node: revenue lost (cents) with each candidate tariff (see _lost_revenue_cents)."""
        self._best_cents: dict[str, int] = {}
        """Best estimated revenue (cents) of each routable trip among its candidate vehicles."""
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
            pickup = Node(
                Role.PICKUP,
                self._point(trip.pickup),
                service_minutes(settings, trip, "PICKUP"),
                windows.pickup,
                1,
                weight,
                trip,
                reference_min=stop_reference_minute(trip, "PICKUP", self.ctx.matrix),
            )
            delivery = Node(
                Role.DELIVERY,
                self._point(trip.dropoff),
                service_minutes(settings, trip, "DROPOFF"),
                windows.dropoff,
                -1,
                -weight,
                trip,
                reference_min=stop_reference_minute(trip, "DROPOFF", self.ctx.matrix),
            )
            self.trip_nodes[trip.id] = (len(self.nodes), len(self.nodes) + 1)
            self.nodes.extend((pickup, delivery))
            self.ride_limits[trip.id] = self._leg(pickup, delivery) + settings.max_ride_extra_min
        for v, member in enumerate(self.fleet):
            rule = member.vehicle.break_
            if member.breaks.mode is not BreakMode.NODE or member.breaks.window is None or rule is None:
                continue
            self.break_nodes[v] = []
            sites = self._break_sites(v, member, member.breaks.window, rule.duration_min)
            for point in [*sites, *(p for p in self._plan_break_sites(v, member) if p not in sites)]:
                self.break_nodes[v].append(len(self.nodes))
                self.nodes.append(
                    Node(Role.BREAK, point, rule.duration_min, member.breaks.window, vehicle=v, reference_min=_middle(member.breaks.window))
                )

    def _break_site_vehicles(self) -> dict[str, frozenset[int]]:
        """Per trip, the vehicles whose break sites may include its places: its candidates, or, for
        a trip locked on a vehicle, every vehicle of an allowed type able to serve it alone.

        A lock says who drives the trip, not where a driver may rest. With the sites of the locked
        trips' vehicles only, « Placer les non affectées » (every trip of the plan in place locked
        on its vehicle) cut a taxi from 23 sites to 4: the break of its plan had no site left, and
        the repair of the plan in place dropped 4 of the 288 trips it had just placed (11/11 of the
        large seed, journal OPT-09)."""
        fleet = self.fleet
        sites: dict[str, frozenset[int]] = {}
        for trip, candidates in self.routable:
            if trip.locked_vehicle_id is None:
                sites[trip.id] = frozenset(candidates)
                continue
            typed = (v for v, member in enumerate(fleet) if member.vehicle.type in trip.allowed_vehicle_types)
            sites[trip.id] = frozenset(v for v in typed if v in candidates or _reachable_alone(self.ctx, trip, fleet[v]))
        return sites

    def _break_sites(self, v: int, member: FleetVehicle, window: Window, duration: int) -> list[int]:
        """Depot first, then the facilities of the trips this vehicle may serve (locks aside,
        _break_site_vehicles), nearest first, then the homes where its driver needs to rest around
        a lunchtime return or a long outbound (_home_break_sites)."""
        matrix = self.ctx.matrix
        depot = self._point(member.vehicle.depot)
        facilities: dict[int, None] = {}
        for trip, _ in self.routable:
            if v in self._site_vehicles[trip.id]:
                facilities.setdefault(self._point(trip.dropoff if trip.direction == "OUTBOUND" else trip.pickup), None)
        facilities.pop(depot, None)
        nearest = sorted(facilities, key=lambda p: matrix.km_by_index(depot, p))[: MAX_BREAK_SITES - 1]
        sites = [depot]
        at_break = _middle(window)
        for point in nearest:
            begin = max(member.shift.open + matrix.leg_by_index(depot, point, None, at_break), window.open)
            if begin <= window.close and begin + duration + matrix.leg_by_index(point, depot, at_break, None) <= member.shift.close:
                sites.append(point)
        return [*sites, *self._home_break_sites(v, member, window, duration, sites)]

    def _plan_break_sites(self, v: int, member: FleetVehicle) -> list[int]:
        """Where the driver of vehicle v rests in its route of the plan in place, as schedule.py
        times it (the response and the validator): the place of the stop before the break and of
        the stop after it (the depot before the first stop or after the last).

        The plan in place carries no break: its repair (_kept_in_place) puts one back at a break
        site. When the sites of this request differ from those of the computation that made the
        plan (other trips, other homes needed, other code), the break it had may have no site left,
        and the repair dropped the trips in its way. schedule.py rests at the next stop, or on the
        way when the window closes before the arrival: a site at either end of that leg holds it."""
        plan = self._plan_by_vehicle.get(member.vehicle.id)
        if plan is None:
            return []
        settings, matrix = self.ctx.request.settings, self.ctx.matrix
        picked: set[str] = set()
        stops: list[PlannedStop] = []
        for ref in plan.stops:
            trip = self.ctx.trips.get(ref.trip_id)
            if trip is None or v not in self._candidates.get(trip.id, ()):
                continue
            if ref.kind == "PICKUP":
                if trip.id in picked:
                    continue
                picked.add(trip.id)
            elif trip.id not in picked:
                continue
            else:
                picked.discard(trip.id)
            location = trip.pickup if ref.kind == "PICKUP" else trip.dropoff
            window = self.ctx.windows[trip.id].for_kind(ref.kind)
            stops.append(PlannedStop(trip, ref.kind, location, service_minutes(settings, trip, ref.kind), window))
        if not stops:
            return []
        schedule = schedule_route(member.vehicle, stops, matrix)
        slot = schedule.break_slot
        if slot is None:
            return []
        timed = schedule.stops
        depot = self._point(member.vehicle.depot)
        before = next((self._point(t.stop.location) for t in reversed(timed) if t.departure_min <= slot[0]), depot)
        after = next((self._point(t.stop.location) for t in timed if t.start_min >= slot[1]), depot)
        return list(dict.fromkeys((before, after)))

    def _home_break_sites(self, v: int, member: FleetVehicle, window: Window, duration: int, sites: Sequence[int]) -> list[int]:
        """Homes where the driver of this vehicle needs to rest, no other site being reachable in
        time (locks aside, _break_site_vehicles), most needed first:
        - where a RETURN trip can end inside the break window, when, the dropoff ending at its
          latest, no other site is reachable before the latest break start. A shared ride may end
          up to maxRideExtraMin later than the patient alone (12/11 of the base seed: a 126 km
          lunchtime return shared with a neighbour ended at 13:29, a minute before the latest break
          start; schedule.py rests on the way back, the depot 5 min away was too late);
        - where an OUTBOUND trip whose ride covers the end of the window starts: the driver rests
          before the pickup, when resting elsewhere then driving there is too late and the break
          cannot follow the dropoff (11/11 of the large seed: a 204 km outbound for 15:00).

        Without them, such trips left no room for the break, although the driver can rest right
        there (the plan recomputed by schedule.py does). Only the homes that are needed: each one
        adds a node.
        """
        matrix = self.ctx.matrix
        settings = self.ctx.request.settings
        needed: dict[int, int] = {}
        """Overshoot (minutes) of each home needed: how late the nearest other site is."""
        for trip, _ in self.routable:
            if v not in self._site_vehicles[trip.id]:
                continue
            home = self._point(trip.dropoff if trip.direction == "RETURN" else trip.pickup)
            if home in sites:
                continue
            windows = self.ctx.windows[trip.id]
            at_pickup, at_dropoff = stop_reference_minute(trip, "PICKUP", matrix), stop_reference_minute(trip, "DROPOFF", matrix)
            leg = matrix.leg(trip.pickup, trip.dropoff, at_pickup, at_dropoff)
            pickup_service = service_minutes(settings, trip, "PICKUP")
            dropoff_service = service_minutes(settings, trip, "DROPOFF")
            if trip.direction == "RETURN":
                ride = pickup_service + leg + dropoff_service
                shared = settings.max_ride_extra_min if trip.shareable and member.vehicle.capacity > 1 else 0
                earliest_end, latest_end = windows.pickup.open + ride, windows.pickup.close + ride + shared
                if earliest_end > window.close or latest_end < window.open:
                    continue
                overshoot = latest_end + min(matrix.leg_by_index(home, site, at_dropoff, None) for site in sites) - window.close
                back = max(earliest_end, window.open) + duration + matrix.leg_by_index(home, sites[0], at_dropoff, None)
                fits = back <= member.shift.close
            else:
                facility = self._point(trip.dropoff)
                latest_pickup = windows.dropoff.close - pickup_service - leg
                rested = window.open + duration
                nearest = min(matrix.leg_by_index(facility, site, at_dropoff, None) for site in sites)
                after = windows.dropoff.open + dropoff_service + nearest
                if rested > latest_pickup or after <= window.close:
                    continue  # no rest fits before the pickup, or the break can follow the dropoff
                overshoot = rested + min(matrix.leg_by_index(site, home, None, at_pickup) for site in sites) - latest_pickup
                arrival = member.shift.open + matrix.leg_by_index(sites[0], home, None, at_pickup)
                back = windows.dropoff.open + dropoff_service + matrix.leg_by_index(facility, sites[0], at_dropoff, None)
                fits = arrival <= window.close and back <= member.shift.close
            if overshoot > 0 and fits:
                needed[home] = max(overshoot, needed.get(home, 0))
        ranked = sorted(needed.items(), key=lambda item: -item[1])  # stable: most needed first, then request order
        return [home for home, _ in ranked[:MAX_BREAK_SITES]]

    def node_at(self, index: int) -> Node:
        return self.nodes[self.manager.IndexToNode(index)]

    def _leg(self, a: Node, b: Node) -> int:
        """Driving minutes between two nodes: the same for the routing model and the checks in Python.

        The drive leaving a break must not be faster than schedule.py will find it: there, the break
        sits on a leg timed as a whole from the stop before it, possibly in an earlier band.
        """
        matrix = self.ctx.matrix
        minutes = matrix.leg_by_index(a.point, b.point, a.reference_min, b.reference_min)
        if a.role is not Role.BREAK:
            return minutes
        return max(minutes, matrix.slowest_by_index(a.point, b.point, a.window.open - BREAK_LEG_LOOKBACK_MIN, a.window.close))

    # -- costs and transit tables
    def _tariff_key(self, vehicle: Vehicle) -> TariffKey:
        """What the revenue of a trip depends on for this vehicle (context.estimated_cents): vehicles
        on the same grid and alike for the TPMR supplement share their arc cost matrix."""
        return (vehicle.tariff_id, vehicle.tpmr_equipped)

    def _estimates(self, trip: Trip, candidates: Sequence[int]) -> dict[TariffKey, int]:
        """Estimated revenue (cents) of `trip` with each candidate vehicle's grid."""
        estimates: dict[TariffKey, int] = {}
        for v in candidates:
            vehicle = self.fleet[v].vehicle
            key = self._tariff_key(vehicle)
            if key not in estimates:
                estimates[key] = self.ctx.estimated_cents(trip, vehicle)
        return estimates

    def _lost_revenue_cents(self) -> list[dict[TariffKey, int]]:
        """Per pickup node: revenue lost (cents) with each candidate grid vs the best one."""
        lost: list[dict[TariffKey, int]] = [{} for _ in self.nodes]
        for trip, candidates in self.routable:
            revenue = self._estimates(trip, candidates)
            best = max(revenue.values(), default=0)
            self._best_cents[trip.id] = best
            pickup, _ = self.trip_nodes[trip.id]
            lost[pickup] = {key: best - value for key, value in revenue.items()}
        return lost

    def best_revenue(self, trip: Trip, candidates: Sequence[int]) -> float:
        """Best estimated revenue (euros) of `trip` among the candidate vehicles."""
        best = self._best_cents.get(trip.id)
        if best is None:
            best = max(self._estimates(trip, candidates).values(), default=0)
        return best / CENTS_PER_EURO

    def _point_rows(self, table: Sequence[Sequence[float]], scale: float) -> dict[int, list[int]]:
        """round(table[p][q] * scale) towards every node, for each distinct point p of the nodes.

        Many nodes share a place (depots, facilities, break sites): one row per place keeps the
        model build fast.
        """
        columns = [node.point for node in self.nodes]
        return {p: [round(table[p][q] * scale) for q in columns] for p in dict.fromkeys(columns)}

    def _time_rows(self) -> list[list[int]]:
        """Transit of the Time dimension: service of the node, then the drive to the next (_leg).

        _leg only reads the place and reference minute of both nodes, and the window of a break
        node: nodes alike on these share their row, and columns alike their value. Break sites
        repeat the same places (facilities, depots) with the same window across the fleet: on the
        11/11 of the large seed (3 072 nodes), computing every cell took 22 s of a 38 s budget."""
        nodes = self.nodes
        column_of = [(node.point, node.reference_min) for node in nodes]
        columns = list(dict.fromkeys(column_of))
        targets = [Node(Role.PICKUP, point, reference_min=reference) for point, reference in columns]
        rows: dict[tuple[object, ...], list[int]] = {}
        result: list[list[int]] = []
        for a in nodes:
            key = (a.role is Role.BREAK, a.point, a.reference_min, a.service_min, a.window if a.role is Role.BREAK else None)
            row = rows.get(key)
            if row is None:
                by_column = dict(zip(columns, (a.service_min + self._leg(a, b) for b in targets), strict=True))
                row = rows[key] = [by_column[column] for column in column_of]
            result.append(row)
        return result

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

        # Arc costs: the km at the fleet's lowest rate, plus the revenue lost on the arc leaving a
        # pickup against the best tariff for the trip; one matrix per tariff (at most one per vehicle
        # type and department). The rest of each vehicle's km cost is a span cost of the Distance
        # dimension (units per meter): a vehicle's own rate adds no matrix (each one is 32 MB at
        # 2 000 nodes). Arcs keep most of the km cost, which the first solution and the guided
        # local search read.
        lost = self._lost_cents = self._lost_revenue_cents()
        base_rate = min(member.vehicle.cost_per_km for member in fleet)
        base_rows = self._point_rows(matrix.km_table, base_rate * CENTS_PER_EURO * UNITS_PER_CENT)
        cost_callbacks: dict[TariffKey, int] = {}
        for v, member in enumerate(fleet):
            tariff = self._tariff_key(member.vehicle)
            if tariff not in cost_callbacks:
                extra = [by_tariff.get(tariff, 0) * UNITS_PER_CENT for by_tariff in lost]
                cost_callbacks[tariff] = routing.RegisterTransitMatrix(self._node_rows(base_rows, extra))
            routing.SetArcCostEvaluatorOfVehicle(cost_callbacks[tariff], v)
        self.cost_matrices = len(cost_callbacks)

        time_rows = self._time_rows()
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
            per_minute = round(member.vehicle.cost_per_hour * CENTS_PER_EURO * UNITS_PER_CENT / 60)
            time_dim.SetSpanCostCoefficientForVehicle(per_minute, v)
            per_meter = round((member.vehicle.cost_per_km - base_rate) * CENTS_PER_EURO * UNITS_PER_CENT / METERS_PER_KM)
            if per_meter:
                distance_dim.SetSpanCostCoefficientForVehicle(per_meter, v)
            if member.work_limit is not None:
                # No legal break inside the route can be guaranteed: at most 6 hours (art. L. 3121-16).
                time_dim.SetSpanUpperBoundForVehicle(member.work_limit, v)
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
            penalty = round((settings.unassigned_penalty + self.best_revenue(trip, candidates)) * CENTS_PER_EURO * UNITS_PER_CENT)
            if trip.locked_vehicle_id is not None:
                penalty *= LOCKED_PENALTY_FACTOR
            self.drop_penalty[trip.id] = penalty
            routing.AddDisjunction([pickup], penalty)
            routing.AddDisjunction([delivery], 0)
            if trip.shareable and any(fleet[v].vehicle.capacity > 1 for v in candidates):
                # Same rounding as the distance dimension.
                self.detour_limits_m[trip.id] = self._meter_rows[p_node][d_node] + detour_allowance_m
                self._limit_ride(distance_dim, pair_index, self.detour_limits_m[trip.id])
            # Time on board (direct drive + maxRideExtraMin, self.ride_limits) is not a limit of the
            # routing model: on the time dimension, whose slack is the waiting, the routing filters
            # check it at a cost that made the first solution of a busy day take 14 s instead of
            # 1 s and held the local search back (journal, OPT-08). The Python steps check it
            # (_insertion_positions, _rule_breaches), and the final check (guarded) on the times
            # schedule.py reports, which the response and the validator use.

        # Outbound and return of a patient: dropping one leg while the other is served costs
        # `coherence` more, paid once per pair (a patient driven to the facility and not back home,
        # or the reverse). Dropping both costs it too: pairs come before lone trips at equal cost.
        coherence = self.coherence_penalty = round(settings.unassigned_penalty * CENTS_PER_EURO * UNITS_PER_CENT)
        for outbound, ret in same_day_pairs([trip for trip, _ in self.routable]):
            self.partner[outbound.id], self.partner[ret.id] = ret.id, outbound.id
            if coherence:
                pickups = [manager.NodeToIndex(self.trip_nodes[t.id][0]) for t in (outbound, ret)]
                routing.AddDisjunction(pickups, coherence, 2, pywrapcp.RoutingModel.PENALIZE_ONCE)

        for v, break_nodes in self.break_nodes.items():
            indices = [manager.NodeToIndex(n) for n in break_nodes]
            for index, n in zip(indices, break_nodes, strict=True):
                _allow_vehicles(routing, index, [v])
                seats_dim.CumulVar(index).SetRange(0, 0)
                time_dim.CumulVar(index).SetRange(nodes[n].window.open, nodes[n].window.close)
            routing.AddDisjunction(indices, BREAK_PENALTY)

    def _limit_ride(self, dimension: pywrapcp.RoutingDimension, pair_index: int, bound: int) -> None:
        """Cumul of the delivery minus the pickup's <= bound on `dimension` (checked by the routing
        filters, not by ReadAssignmentFromRoutes: the Python steps check it themselves)."""

        def limit(_pickup_alternative: int, _delivery_alternative: int) -> int:
            return bound

        self._limit_functions.append(limit)
        dimension.SetPickupToDeliveryLimitFunctionForPair(limit, pair_index)

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
        """Starts built in Python (plan in place, insertions from the breaks), first solution, break
        repair, reinsertion, a short search from every start and the rest of the time from the best
        (see module docstring), all within `time_limit_sec` (the Python starts and the first
        solution may each use FIRST_SOLUTION_GRACE_SEC more, the fallback after a failed first
        solution FALLBACK_SEARCH_SEC); None when no plan was found."""
        started = time.monotonic()
        deadline = started + time_limit_sec
        # The safety nets, built and confirmed before any solve: once a solve has used up its
        # routing limit, ReadAssignmentFromRoutes fails, and restoring a start set by
        # RoutesToAssignment instead took 46 s on a 2 000-node model (0.1 s here).
        starts = self._python_starts(deadline, deadline + FIRST_SOLUTION_GRACE_SEC)
        prepared = time.monotonic()
        # The routing limit set here also bounds the restore of the repaired plan below: the grace
        # keeps it alive for the repair when the first solution ends near the budget.
        first_limit = max(deadline - prepared, 0.0) + FIRST_SOLUTION_GRACE_SEC
        predicted = FIRST_SOLUTION_SEC_PER_NODE3 * len(self.nodes) ** 3
        if starts and predicted > first_limit:
            # It could not finish: cut short, it places no trip (0 of 297 in 32 s at 2 000 nodes) and
            # its result was thrown away after the whole budget. The local search does not pay off
            # at that size either (1 % of km in 10 min): the cheapest Python start is the plan, at once.
            self.first_solution_skipped = True
            self.search_status = STATUS_INSERTION
            chosen = self._cheapest(starts)
            self.start_label = chosen.label
            logger.info(
                "solver: first solution skipped (%d nodes: about %.0f s predicted, %.1f s left): start '%s' returned",
                len(self.nodes),
                predicted,
                first_limit,
                chosen.label,
            )
            return chosen.solution
        first = self.routing.SolveWithParameters(self._params(first_limit, first_solution_only=True))
        self.search_status = _status_name(self.routing)
        built = time.monotonic()
        if first is None:
            logger.warning("solver: no first solution after %.1f s (%s)", built - prepared, self.search_status)
            self.first_solution_failed = True
            return self._search_without_first_solution(self._cheapest(starts) if starts else None, deadline)
        cut_short = built - prepared >= first_limit
        if built > deadline:
            logger.warning("solver: first solution took %.1f s, over the %s s budget", built - prepared, time_limit_sec)
        repaired, kept = self._repaired(first, prepared + first_limit - RESTORE_MARGIN_SEC)
        logger.info(
            "solver: first solution %.2f s (%d trips placed), break repair %d trips kept, reinsertion %d trips placed (%.2f s)",
            built - prepared,
            self._placed(first),
            kept,
            self._placed(repaired),
            time.monotonic() - built,
        )
        if cut_short and starts and self._cheapest(starts).solution.ObjectiveValue() < repaired.ObjectiveValue():
            # A Python start is cheaper because the first solution ran out of time (a large fleet):
            # more time may help.
            self.first_solution_failed = True
            logger.info("solver: first solution cut short")
        return self._portfolio([*starts, _Start("first solution", repaired, self._routes(repaired))], deadline)

    def _python_starts(self, deadline: float, last_deadline: float) -> list[_Start]:
        """Starts built in Python and confirmed by the routing model: the plan in place repaired,
        when the web sent one; the insertion from the breaks, other leg of a served patient first;
        and, when the first solution will run and leave time for a search, the same insertion by
        regret alone. Each may run until `last_deadline`."""
        starts: list[_Start] = []
        if self.initial_routes:
            began = time.monotonic()
            routes = self._from_plan(self.initial_routes, last_deadline)
            logger.info("solver: plan in place repaired %.2f s (%d trips placed)", time.monotonic() - began, self._placed_in(routes))
            confirmed = self._confirmed("plan in place", routes)
            if confirmed:
                # Only a plan the routing model accepted may be returned instead of the search's
                # (solve): the final comparison does not look at the rules.
                self.warm_routes = [list(route) for route in routes]
            starts.extend(confirmed)
        began = time.monotonic()
        routes = self._built_from_breaks(last_deadline)
        spent = time.monotonic() - began
        self.inserted_trips = self._placed_in(routes)
        logger.info("solver: insertion from the breaks %.2f s (%d trips placed)", spent, self.inserted_trips)
        starts.extend(self._confirmed("insertion", routes))
        # Ordering the insertion by regret alone leads the search elsewhere: on the demo days,
        # each of the two orders gave the better plan on two days out of four (journal, OPT-08).
        # Only worth it when a search follows: a large fleet gets the first insertion at once.
        left = deadline - time.monotonic()
        if FIRST_SOLUTION_SEC_PER_NODE3 * len(self.nodes) ** 3 + spent < left:
            began = time.monotonic()
            regret = self._built_from_breaks(last_deadline, pairs_first=False)
            logger.info(
                "solver: insertion by regret alone %.2f s (%d trips placed)", time.monotonic() - began, self._placed_in(regret)
            )
            if regret != routes:
                starts.extend(self._confirmed("insertion by regret", regret))
        return starts

    def _confirmed(self, label: str, routes: list[list[int]]) -> list[_Start]:
        """The routes as a start, once the routing model accepted them (none if it did not)."""
        solution = self.routing.ReadAssignmentFromRoutes(routes, True)
        if solution is None:
            logger.warning("solver: start '%s' rejected by the routing model", label)
            return []
        return [_Start(label, solution, routes)]

    @staticmethod
    def _cheapest(starts: Sequence[_Start]) -> _Start:
        """The start of lowest objective (the first listed on a tie)."""
        return min(starts, key=lambda start: start.solution.ObjectiveValue())

    def _portfolio(self, starts: Sequence[_Start], deadline: float) -> pywrapcp.Assignment:
        """Guided local search from every start for a short while (PROBE_SHARE of the time left,
        shared), then from the best plan found until the deadline.

        The local search rarely places a trip its start left out: the start decides where it ends,
        and the cheapest start is not the one that ends best (2026-11-10 of the demo: from the
        first solution 57 trips, from either insertion 59; journal, OPT-08). Each search from an
        insertion reaches its plan in about a second on a 60-trip day."""
        remaining = deadline - time.monotonic()
        ordered: list[_Start] = []
        for start in sorted(starts, key=lambda start: start.solution.ObjectiveValue()):  # stable
            if all(start.routes != other.routes for other in ordered):
                ordered.append(start)
        probe = remaining * PROBE_SHARE / len(ordered)
        if remaining < MIN_LOCAL_SEARCH_SEC or len(ordered) == 1 or probe < MIN_PROBE_SEC:
            chosen = ordered[0]
            self.start_label = chosen.label
            logger.info("solver: start: %s", chosen.label)
            if remaining < MIN_LOCAL_SEARCH_SEC:
                return chosen.solution
            return self._local_search(chosen.solution, remaining)[0]
        found: list[tuple[int, int, pywrapcp.Assignment, str]] = []
        for rank, start in enumerate(ordered):
            solution, status = self._local_search(start.solution, probe)
            found.append((solution.ObjectiveValue(), rank, solution, status))
            logger.info(
                "solver: search from the %s: %d -> %d trips placed, objective %.0f -> %.0f",
                start.label,
                self._placed(start.solution),
                self._placed(solution),
                start.solution.ObjectiveValue() / UNITS_PER_CENT,
                solution.ObjectiveValue() / UNITS_PER_CENT,
            )
        _, rank, best, status = min(found, key=lambda item: item[:2])
        self.start_label = ordered[rank].label
        self.search_status = status
        logger.info("solver: start: %s", self.start_label)
        rest = deadline - time.monotonic()
        if rest < MIN_LOCAL_SEARCH_SEC:
            return best
        return self._local_search(best, rest)[0]

    def _local_search(self, start: pywrapcp.Assignment, seconds: float) -> tuple[pywrapcp.Assignment, str]:
        """Guided local search from `start` and its status (`start` itself when the search returns
        nothing); search_status follows the last search."""
        began = time.monotonic()
        best = self.routing.SolveFromAssignmentWithParameters(start, self._params(seconds))
        if best is None:
            return start, self.search_status
        self.search_status = _status_name(self.routing)
        logger.info("solver: local search %.2f s (%d trips placed) -> %s", time.monotonic() - began, self._placed(best), self.search_status)
        return best, self.search_status

    def _search_without_first_solution(self, start: _Start | None, deadline: float) -> pywrapcp.Assignment | None:
        """Search when the first solution failed: local search from the cheapest Python start
        (confirmed before the failed solve) until the deadline, at least FALLBACK_SEARCH_SEC; from
        the breaks-only routes (always feasible) if the routing model rejected every start.

        The failed solve used up its routing limit, under which ReadAssignmentFromRoutes would
        fail: the breaks-only start only sets the routes (RoutesToAssignment) and the search, with
        a fresh limit, restores it.
        """
        seconds = max(deadline - time.monotonic(), FALLBACK_SEARCH_SEC)
        if start is not None:
            self.start_label = start.label
            best, _ = self._local_search(start.solution, seconds)
            logger.info("solver: local search from the %s: %d trips placed", start.label, self._placed(best))
            return best
        breaks_only = self.routing.solver().Assignment()
        if not self.routing.RoutesToAssignment(self._breaks_only_routes(), True, True, breaks_only):
            logger.warning("solver: no start accepted by the routing model (%s)", self.search_status)
            return None
        best = self.routing.SolveFromAssignmentWithParameters(breaks_only, self._params(seconds))
        self.search_status = _status_name(self.routing)
        if best is None:
            logger.warning("solver: no start accepted by the routing model (%s)", self.search_status)
            return None
        self.start_label = "breaks alone"
        logger.info("solver: local search from the breaks alone: %d trips placed -> %s", self._placed(best), self.search_status)
        return best

    def _breaks_only_routes(self) -> list[list[int]]:
        """Each vehicle's break at its cheapest feasible site (the depot) and nothing else."""
        return [self._with_break([], v) or [] if v in self.break_nodes else [] for v in range(len(self.fleet))]

    def _built_from_breaks(self, deadline: float, *, pairs_first: bool = True) -> list[list[int]]:
        """Routes built in Python: the breaks alone, then every trip by regret insertion (breaks
        moved when needed, see _cheapest_insertion), until the deadline."""
        routes = self._breaks_only_routes()
        self._insert_left_out(routes, deadline, pairs_first=pairs_first)
        return routes

    # -- warm start: the plan in place
    def _from_plan(self, plans: Sequence[RoutePlan], deadline: float) -> list[list[int]]:
        """Routes of the plan in place (contract `initialRoutes`) that the rules of this request
        allow, completed: per route of a usable vehicle, the trips it may serve (vehicle type, lock)
        picked up then dropped off on it, once in the day, in the order given; then each route
        without the trips that break a rule (seats, exclusive ride, times, shift, work time, detour,
        time on board, wait at the facility; _kept_in_place), with its break; then the trips taken
        out, and after them every other trip left out, back where they fit (_insert_left_out),
        until `deadline`."""
        position = {member.vehicle.id: v for v, member in enumerate(self.fleet)}
        routes = self._breaks_only_routes()
        given: set[int] = set()
        taken: set[str] = set()
        for plan in plans:
            v = position.get(plan.vehicle_id)
            if v is None or v in given:
                continue
            given.add(v)
            picked: dict[str, None] = {}
            complete: dict[str, None] = {}
            for ref in plan.stops:
                trip_id = ref.trip_id
                if trip_id in taken or trip_id not in self.trip_nodes or v not in self._candidates[trip_id]:
                    continue
                if ref.kind == "PICKUP":
                    picked[trip_id] = None
                elif trip_id in picked:
                    complete[trip_id] = None
            sequence: list[int] = []
            boarded: set[str] = set()
            for ref in plan.stops:
                trip_id = ref.trip_id
                if trip_id not in complete:
                    continue
                p_node, d_node = self.trip_nodes[trip_id]
                if ref.kind == "PICKUP" and trip_id not in boarded:
                    boarded.add(trip_id)
                    sequence.append(self.manager.NodeToIndex(p_node))
                elif ref.kind == "DROPOFF" and trip_id in boarded:
                    boarded.discard(trip_id)
                    del complete[trip_id]  # a later stop of this trip is ignored
                    taken.add(trip_id)
                    sequence.append(self.manager.NodeToIndex(d_node))
            routes[v] = self._kept_in_place(v, sequence)
        # The trips the repair took out go back first, as in guarded: a cheaper trip left out of
        # the plan in place must not take the slot of one of its trips (locked or not).
        kept = {trip_id for route in routes for trip_id in self._trip_ids(route)}
        if taken - kept:
            self._insert_left_out(routes, deadline, only=taken - kept)
        self._insert_left_out(routes, deadline)
        return routes

    def _kept_in_place(self, v: int, sequence: Sequence[int]) -> list[int]:
        """The route of vehicle v without the trips that break a rule, with its break if it has
        one: the trips over the seats or with company in an exclusive ride, and those breaking
        their detour, time on board or wait at the facility (_without_trips), then the trip of
        the first stop that cannot be on time (or the last trip when the route ends too late or
        too long), until it holds; the break then takes its cheapest feasible empty position,
        trips leaving only if needed (_fit_break)."""
        kept = list(sequence)
        while True:
            kept = self._without_trips(kept, self._overloaded(v, kept), v)
            late = self._late_trip(v, kept)
            if late is None:
                break
            kept = self._without_trips(kept, {late}, v)
        if v not in self.break_nodes:
            return kept
        _, _, starts = self._packed(v, kept)
        return self._fit_break(kept, v, dict(zip(kept, starts, strict=True)))

    def _overloaded(self, v: int, sequence: Sequence[int]) -> set[str]:
        """Trips picked up when vehicle v has no seat left, or with someone else on board in an
        exclusive ride (the earlier passengers stay)."""
        capacity = self.fleet[v].vehicle.capacity
        seats = alone = 0
        over: set[str] = set()
        for index in sequence:
            node = self.node_at(index)
            if node.trip is None or node.trip.id in over:
                continue
            if node.role is Role.PICKUP and (seats + node.seats > capacity or alone + node.exclusive > EXCLUSIVE_WEIGHT):
                over.add(node.trip.id)
                continue
            seats += node.seats
            alone += node.exclusive
        return over

    def _late_trip(self, v: int, sequence: Sequence[int]) -> str | None:
        """Trip of the first stop of the route that cannot start inside its window (earliest
        starts, like _time_feasible), or its last trip when the route ends after the shift or
        lasts longer than the work limit; None when the route is on time."""
        previous = self.nodes[v]
        clock = self.fleet[v].shift.open
        nodes: list[Node] = []
        earliest: list[int] = []
        for index in sequence:
            node = self.node_at(index)
            clock = max(clock + previous.service_min + self._leg(previous, node), node.window.open)
            if clock > node.window.close and node.trip is not None:
                return node.trip.id
            nodes.append(node)
            earliest.append(clock)
            previous = node
        clock += previous.service_min + self._leg(previous, self.nodes[v])
        if clock <= self.fleet[v].shift.close and self._span_fits(v, nodes, earliest, clock):
            return None
        return next((node.trip.id for node in reversed(nodes) if node.trip is not None), None)

    def plan_score(self, routes: Sequence[Sequence[int]]) -> float:
        """What the objective weighs, in euros, on the times and revenue the response will report
        (plan.plan_margin: sharing discount included): the penalty of every trip left out (twice for
        a locked one), that of every patient whose outbound and return are not both served (both
        legs left out included, as the pair disjunction counts it), minus the margin. Lower is
        better. A weighted sum, like the objective, not a strict order: one more trip served weighs
        as much as one fewer half-served patient, and the margin then decides."""
        margin, served = plan_margin(self.ctx, self.sequences(routes))
        penalty = self.ctx.request.settings.unassigned_penalty
        dropped = sum(
            penalty * (LOCKED_PENALTY_FACTOR if trip.locked_vehicle_id is not None else 1)
            for trip, _ in self.routable
            if trip.id not in served
        )
        broken_pairs = sum(
            1
            for trip_id, partner in self.partner.items()
            if self.ctx.trips[trip_id].direction == "OUTBOUND" and not (trip_id in served and partner in served)
        )
        return dropped + broken_pairs * penalty - margin

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

    def routes_of(self, solution: pywrapcp.Assignment) -> list[list[int]]:
        """Visited indices (depots excluded) of every vehicle in the solution."""
        return self._routes(solution)

    # -- time on board, wait on board at the facility, work time
    def _packed(self, v: int, sequence: Sequence[int]) -> tuple[list[Node], list[int], list[int]]:
        """Nodes of the route of vehicle v with their arrival and service start minutes, timed like
        schedule.py: earliest starts, then each stop followed by a patient on board delayed as late
        as the next stop allows (never past its window). Break nodes count as stops, where
        schedule.py places the break itself: close, not exact (_guarded checks the exact times)."""
        member, depot = self.fleet[v], self.nodes[v]
        nodes = [self.node_at(index) for index in sequence]
        starts: list[int] = []
        loads: list[int] = []
        clock, previous, load = member.shift.open, depot, 0
        for node in nodes:
            clock = max(clock + previous.service_min + self._leg(previous, node), node.window.open)
            load += node.seats
            starts.append(clock)
            loads.append(load)
            previous = node
        for k in reversed(range(len(nodes) - 1)):
            if loads[k]:
                node = nodes[k]
                starts[k] = max(starts[k], min(node.window.close, starts[k + 1] - self._leg(node, nodes[k + 1]) - node.service_min))
        # The depot departure waits for the first stop (no wait there).
        arrivals = [starts[0], *(starts[k - 1] + nodes[k - 1].service_min + self._leg(nodes[k - 1], nodes[k]) for k in range(1, len(nodes)))] if nodes else []
        return nodes, arrivals, starts

    def _on_board_breaches(self, nodes: Sequence[Node], arrivals: Sequence[int], starts: Sequence[int]) -> set[str]:
        """Trips of a timed route whose patient rides longer than its ride limit, or waits at the
        facility, counting the time the vehicle stands there with them on board waiting for another
        stop's window, beyond the window of their trip (the share of the 45 min given to that leg)."""
        breaches: set[str] = set()
        boarded: dict[str, int] = {}
        for k, node in enumerate(nodes):
            trip = node.trip
            if trip is None:
                continue
            if node.role is Role.PICKUP:
                boarded[trip.id] = k
                continue
            i = boarded.pop(trip.id, None)
            if i is None:
                continue
            pickup = nodes[i]
            if starts[k] - (starts[i] + pickup.service_min) > self.ride_limits[trip.id]:
                breaches.add(trip.id)
            elif trip.direction == "OUTBOUND":
                if starts[k] - self._standing(nodes, arrivals, starts, range(k, i, -1), node.point) < node.window.open:
                    breaches.add(trip.id)
            elif starts[i] + self._standing(nodes, arrivals, starts, range(i + 1, k), pickup.point) > pickup.window.close:
                breaches.add(trip.id)
        return breaches

    @staticmethod
    def _standing(nodes: Sequence[Node], arrivals: Sequence[int], starts: Sequence[int], positions: range, point: int) -> int:
        """Minutes waited (start - arrival) at the stops of `positions` while the vehicle stays at `point`."""
        waited = 0
        for k in positions:
            if nodes[k].point != point:
                break
            waited += max(0, starts[k] - arrivals[k])
        return waited

    def _rule_breaches(self, v: int, sequence: Sequence[int]) -> set[str]:
        """Trips of the route breaking their ride limit or their wait at the facility (_packed times)."""
        return self._on_board_breaches(*self._packed(v, sequence))

    def _scheduled(self, v: int, sequence: Sequence[int]) -> tuple[list[Node], RouteSchedule] | None:
        """Trip nodes of the route and their schedule as the response reports it (schedule.py)."""
        nodes = [node for node in (self.node_at(index) for index in sequence) if node.trip is not None]
        if not nodes:
            return None
        stops = [
            PlannedStop(
                trip=node.trip,
                kind="PICKUP" if node.role is Role.PICKUP else "DROPOFF",
                location=node.trip.pickup if node.role is Role.PICKUP else node.trip.dropoff,
                service_min=node.service_min,
                window=node.window,
            )
            for node in nodes
            if node.trip is not None
        ]
        return nodes, schedule_route(self.fleet[v].vehicle, stops, self.ctx.matrix)

    def _scheduled_breaches(self, v: int, sequence: Sequence[int]) -> set[str]:
        """Trips of the route breaking a rule the solver cannot see exactly (_scheduled_reasons)."""
        return set(self._scheduled_reasons(v, sequence))

    def _scheduled_reasons(self, v: int, sequence: Sequence[int]) -> dict[str, str]:
        """Trips of the route breaking a rule the solver cannot see exactly, on the times schedule.py
        reports, with the reason to give if they stay out: ride limit and wait on board at the
        facility, or else a route longer than 6 hours without a legal break inside it
        (art. L. 3121-16: then its first or last trip, the cheaper to drop)."""
        scheduled = self._scheduled(v, sequence)
        if scheduled is None:
            return {}
        nodes, schedule = scheduled
        breaches = self._on_board_breaches(
            nodes, [timed.arrival_min for timed in schedule.stops], [timed.start_min for timed in schedule.stops]
        )
        if breaches:
            return dict.fromkeys(sorted(breaches), REASON_DROPPED_ON_BOARD)
        if _lawful_work_time(schedule):
            return {}
        ends = [trip for trip in (nodes[0].trip, nodes[-1].trip) if trip is not None]
        return {min(ends, key=lambda trip: (self.drop_penalty[trip.id], trip.id)).id: REASON_DROPPED_WORK_TIME}

    def guarded(self, routes: list[list[int]], seconds: float = GUARD_SEC) -> dict[str, str]:
        """Final check of the plan on the times the response will report (schedule.py): the trips
        that break the ride limit, the wait at the facility or the work time are taken out of
        `routes` (changed in place); then they, and every trip the search left out, go back where
        they pass the same check, within `seconds`. Returns the trips taken out and still left out,
        with their reason. The routing model does not bound the time on board nor the wait on board
        (since OPT-08), and bounds the work time only as a span of the time cumuls it picks: before
        this check, only the Python steps hold these rules, on close times (_packed).

        The trips the search left out get one more try because its moves cannot place a trip that
        only fits once the vehicle's break moves, which the Python insertion does
        (_cheapest_insertion). With make_room, 2 to 7 more trips served on the busy days (journal,
        OPT-09). The trips taken out go back first, on their own: the regret insertion ranks by
        partner, regret and cost, never by lock, so a cheaper trip the search left out could take
        the slot a locked trip had just held (« Placer les non affectées » locks every trip in
        place: such a plan is discarded by the web)."""
        removed: dict[str, str] = {}
        for v in range(len(self.fleet)):
            while breaches := self._scheduled_reasons(v, routes[v]):
                # Ties broken by id: the choice must not depend on the hash seed (tests/hashseed_probe.py).
                cheapest = min(breaches, key=lambda trip_id: (self.drop_penalty[trip_id], trip_id))
                before = self._trip_ids(routes[v])
                routes[v] = self._without_trips(routes[v], {cheapest}, v)
                after = set(self._trip_ids(routes[v]))
                # The co-passengers taken out with it would ride too long or wait on board without it.
                removed.update(
                    (trip_id, breaches[cheapest] if trip_id == cheapest else REASON_DROPPED_ON_BOARD)
                    for trip_id in before
                    if trip_id not in after
                )
        deadline = time.monotonic() + seconds
        self._exact_checks = True
        try:
            placed = self._insert_left_out(routes, deadline, only=set(removed)) if removed else 0
            placed += self._insert_left_out(routes, deadline)
        finally:
            self._exact_checks = False
        served = {trip_id for route in routes for trip_id in self._trip_ids(route)}
        back = sum(1 for trip_id in removed if trip_id in served)
        if removed:
            logger.warning("solver: final check took %d trip(s) out (on board or work time), %d reinserted", len(removed), back)
        if placed > back:
            logger.info("solver: final check placed %d trip(s) the search left out", placed - back)
        return {trip_id: reason for trip_id, reason in removed.items() if trip_id not in served}

    def restore_pairs(self, routes: list[list[int]], seconds: float = PAIR_REPAIR_SEC) -> int:
        """Give a patient whose outbound or return alone is served their other leg (returns first:
        a patient left at the facility), by taking out of a route a trip in the way whose loss costs
        less (a lone trip, or one whose own pair is not served either); that trip is then reinserted
        where it fits. Checked on the times schedule.py reports. `routes` changes in place; returns
        the number of legs given back.

        The routing search cannot do it: placing the missing leg needs another trip to leave at the
        same time, a move its operators do not make (on the busy day, the pair penalty alone left as
        many half-served patients)."""
        deadline = time.monotonic() + seconds
        served = {trip_id for route in routes for trip_id in self._trip_ids(route)}
        missing = [
            trip_id
            for trip_id, partner in self.partner.items()
            if trip_id not in served and partner in served
        ]
        missing.sort(key=lambda trip_id: self.ctx.trips[trip_id].direction != "RETURN")  # stable: returns first
        restored = 0
        self._exact_checks = True
        try:
            for trip_id in missing:
                if time.monotonic() >= deadline:
                    break
                swap = self._best_swap(routes, served, self.ctx.trips[trip_id], deadline)
                if swap is None:
                    continue
                v, sequence, dropped = swap
                routes[v] = sequence
                served.discard(dropped)
                served.add(trip_id)
                restored += 1
                if self._insert_left_out(routes, deadline, only={dropped}):
                    served.add(dropped)
        finally:
            self._exact_checks = False
        if restored:
            logger.info("solver: %d outbound/return leg(s) given back to half-served patients", restored)
        return restored

    def make_room(self, routes: list[list[int]], seconds: float) -> int:
        """Each trip still left out (the other leg of a served trip first) takes the place of a
        trip in its way, which then fits elsewhere: on another vehicle, or at another position of
        the same. One more trip served, none lost; checked on the times schedule.py reports.
        `routes` changes in place; returns the number of trips placed.

        Neither the routing search nor the insertion makes this double move. At 120 vehicles the
        plan is the Python insertion alone (no local search, see search), whose greedy order can
        leave a trip for which a single move would make room: on the 480-trip bench, one more
        ambulance trip served (journal, OPT-09)."""
        deadline = time.monotonic() + seconds
        served = {trip_id for route in routes for trip_id in self._trip_ids(route)}
        left = [trip for trip, _ in self.routable if trip.id not in served]
        left.sort(key=lambda trip: -self._partner_rank(trip.id, served))  # stable: half-served patients first
        placed = 0
        self._exact_checks = True
        try:
            for trip in left:
                if time.monotonic() >= deadline:
                    break
                changes = self._room_for(routes, trip, deadline)
                if changes is None:
                    continue
                for v, sequence in changes:
                    routes[v] = sequence
                served.add(trip.id)
                placed += 1
        finally:
            self._exact_checks = False
        if placed:
            logger.info("solver: %d trip(s) placed by moving a trip in their way", placed)
        return placed

    def _room_for(self, routes: Sequence[Sequence[int]], trip: Trip, deadline: float) -> list[tuple[int, list[int]]] | None:
        """The cheapest route changes, (vehicle, new route) pairs, that serve `trip` by moving one
        trip in its way (a ride within PAIR_REPAIR_SLACK_MIN of its own), None when there are none
        (the best found so far when the deadline passes)."""
        p_node, d_node = self.trip_nodes[trip.id]
        first = (self.nodes[p_node].reference_min or 0) - PAIR_REPAIR_SLACK_MIN
        last = (self.nodes[d_node].reference_min or HORIZON_MIN) + PAIR_REPAIR_SLACK_MIN
        best: tuple[float, list[tuple[int, list[int]]]] | None = None
        for v in self._candidates[trip.id]:
            route = routes[v]
            nodes, _, starts = self._packed(v, route)
            boarded: dict[str, int] = {}
            in_the_way: list[str] = []
            for k, node in enumerate(nodes):
                if node.trip is None:
                    continue
                if node.role is Role.PICKUP:
                    boarded[node.trip.id] = starts[k]
                elif starts[k] >= first and boarded.pop(node.trip.id, starts[k]) <= last:
                    in_the_way.append(node.trip.id)
            for other_id in in_the_way:
                if time.monotonic() >= deadline:
                    return None if best is None else best[1]
                trial = [index for index in route if (other := self.node_at(index).trip) is None or other.id != other_id]
                fit = self._cheapest_insertion(trial, v, trip)
                if fit is None:
                    continue
                for w in self._candidates[other_id]:
                    again = self._cheapest_insertion(fit[1] if w == v else routes[w], w, self.ctx.trips[other_id])
                    if again is not None and (best is None or fit[0] + again[0] < best[0]):
                        best = (fit[0] + again[0], [(v, again[1])] if w == v else [(v, fit[1]), (w, again[1])])
        return None if best is None else best[1]

    def _best_swap(
        self, routes: Sequence[Sequence[int]], served: set[str], leg: Trip, deadline: float
    ) -> tuple[int, list[int], str] | None:
        """(vehicle, route, trip taken out) that places `leg` at the least loss, None when no trip in
        the way costs less to drop than the half-served patient."""
        p_node, d_node = self.trip_nodes[leg.id]
        first = (self.nodes[p_node].reference_min or 0) - PAIR_REPAIR_SLACK_MIN
        last = (self.nodes[d_node].reference_min or HORIZON_MIN) + PAIR_REPAIR_SLACK_MIN
        worth = self.drop_penalty[leg.id] + self.coherence_penalty
        own_leg = self.partner.get(leg.id)
        best: tuple[float, int, list[int], str] | None = None
        for v in self._candidates[leg.id]:
            if time.monotonic() >= deadline:
                break
            route = routes[v]
            nodes, _, starts = self._packed(v, route)
            boarded: dict[str, int] = {}
            for k, node in enumerate(nodes):
                trip = node.trip
                if trip is None:
                    continue
                if node.role is Role.PICKUP:
                    boarded[trip.id] = starts[k]
                    continue
                begin = boarded.pop(trip.id, starts[k])
                # Taking out one leg of a served pair, or the served leg of this patient (swapping
                # outbound and return), would only move the problem.
                if (
                    starts[k] < first
                    or begin > last
                    or trip.id == own_leg
                    or self.partner.get(trip.id) in served
                ):
                    continue
                loss = self.drop_penalty[trip.id]
                if loss >= worth:
                    continue
                trial = [index for index in route if (other := self.node_at(index).trip) is None or other.id != trip.id]
                fit = self._cheapest_insertion(trial, v, leg)
                if fit is None:
                    continue
                gain = worth - loss - fit[0] * UNITS_PER_CENT
                if gain > 0 and (best is None or gain > best[0]):
                    best = (gain, v, fit[1], trip.id)
        return None if best is None else (best[1], best[2], best[3])

    def left_out_reason(
        self, trip: Trip, routes: Sequence[Sequence[int]], schedules: dict[int, RouteSchedule | None], deadline: float
    ) -> str:
        """Why the final routes have no place for `trip`, in French for the regulator: the trip's
        own times (the appointment of an outbound, the end of session of a return), then what keeps
        each compatible vehicle from taking it (_obstacle), named up to MAX_NAMED_VEHICLES and
        counted above; « le véhicule figé » for a trip locked on its vehicle, which the web names
        around the reason. `schedules` caches the timing of each route (schedule.py, as the response
        reports it) across the trips left out; past `deadline`, the reason only gives the trip's
        times. Checked like the final passes, on the times schedule.py reports."""
        p_node, d_node = self.trip_nodes[trip.id]
        pickup, delivery = self.nodes[p_node], self.nodes[d_node]
        ride = pickup.service_min + self._leg(pickup, delivery)
        if trip.direction == "OUTBOUND":
            begin, span = delivery.window.close - ride, (delivery.window.open - ride, delivery.window.close)
        else:
            begin, span = pickup.window.open, (pickup.window.open, pickup.window.close + ride)
        head = f"{REASON_DROPPED_PREFIX} {hhmm(begin)} à {hhmm(begin + ride)}{NBSP}: "
        candidates = self._candidates[trip.id]
        found: list[tuple[str, str]] = []
        """(kind, what keeps the vehicle from taking the trip) per compatible vehicle."""
        self._exact_checks = True
        try:
            for v in candidates:
                if time.monotonic() >= deadline:
                    return head + REASON_DROPPED_DETAIL
                found.append(self._obstacle(v, routes[v], trip, span, schedules))
        finally:
            self._exact_checks = False
        return head + self._obstacles_text(trip, candidates, found)

    def _obstacles_text(self, trip: Trip, candidates: Sequence[int], found: Sequence[tuple[str, str]]) -> str:
        """The obstacles of every compatible vehicle (_obstacle), worded for left_out_reason."""
        if trip.locked_vehicle_id is not None:
            return f"le véhicule figé {found[0][1]}"
        if all(kind == "alone" for kind, _ in found):
            # Whatever the plan, no driver can take it: say what the regulator can do.
            if len(found) == 1:
                return f"{_label(self.fleet[candidates[0]].vehicle)} {ALONE_TEXT}{NBSP}: {ALONE_ADVICE}"
            return (
                f"aucun des {len(found)} véhicules compatibles ne peut l'assurer avec la pause de son chauffeur, "
                f"même sans autre course{NBSP}: {ALONE_ADVICE}"
            )
        if len(found) <= MAX_NAMED_VEHICLES:
            names = [_label(self.fleet[v].vehicle) for v in candidates]
            return f"{NNBSP}; ".join(f"{name} {what}" for name, (_, what) in zip(names, found, strict=True))
        counts = {kind: sum(1 for k, _ in found if k == kind) for kind in LEFT_OUT_KINDS}
        if len([count for count in counts.values() if count]) == 1:
            kind = next(kind for kind, count in counts.items() if count)
            return LEFT_OUT_KINDS[kind][1].format(f"les {len(found)} véhicules compatibles")
        parts = [LEFT_OUT_KINDS[kind][0 if count == 1 else 1].format(count) for kind, count in counts.items() if count]
        return f"sur {len(found)} véhicules compatibles, " + ", ".join(parts[:-1]) + " et " + parts[-1]

    def _obstacle(
        self, v: int, route: Sequence[int], trip: Trip, span: tuple[int, int], schedules: dict[int, RouteSchedule | None]
    ) -> tuple[str, str]:
        """(kind of LEFT_OUT_KINDS, French text) of what keeps vehicle v from taking `trip` into
        `route`. Each possible cause is taken away in turn, and the first whose absence lets the
        trip in (the exact insertion, the break free to move, _cheapest_insertion) is named, so
        that the reason never blames what the vehicle merely does meanwhile (12/11 of the small
        seed: an ambulance « en pause » that could not take the trip without its break either):
        - "alone": the trip and the driver's break do not fit even in an otherwise empty day;
        - "free": nothing, the trip fits the route as it is (a final pass changed it after the
          last try; never seen on the seeds and the demo);
        - the patients on board during `span`, every minute the trip may ride (its whole pickup
          window for a return, arrival window for an outbound): "busy" when no seat can take it
          (an exclusive ride, a full vehicle), "share" otherwise (the shared ride breaks the
          detour, the time on board or the windows);
        - "break": the break of the route, when it falls in `span`;
        - "tight": the trip right after `span`, then the one right before, named by its stop;
        - "break": the break of the route outside `span` (it cannot move for the trip);
        - "tight" otherwise, with the stops around `span` (several trips in the way)."""
        if v not in self._alone_routes:
            self._alone_routes[v] = (self._with_break([], v) or []) if v in self.break_nodes else []
        if self._cheapest_insertion(self._alone_routes[v], v, trip) is None:
            if v in self.break_nodes:
                return "alone", ALONE_TEXT
            return "tight", "n'a pas le temps de l'assurer dans ses heures de service"
        if self._cheapest_insertion(route, v, trip) is not None:
            # A final pass changed the route after the last try (make_room): never blame a cause.
            return "free", "a la place de la prendre (à placer à la main)"
        if v not in schedules:
            scheduled = self._scheduled(v, route)
            schedules[v] = None if scheduled is None else scheduled[1]
        schedule = schedules[v]
        if schedule is None:
            return "tight", "n'a pas le temps de l'assurer"
        first, last = span
        periods: dict[str, tuple[int, int]] = {}
        """Pickup and dropoff service starts of each trip of the route, in route order."""
        for timed in schedule.stops:
            trip_id = timed.stop.trip.id
            start = periods.get(trip_id, (timed.start_min, timed.start_min))[0]
            periods[trip_id] = (start, timed.start_min)
        aboard = [trip_id for trip_id, (a, b) in periods.items() if a < last and b > first]
        if aboard and self._fits_without(v, route, trip, set(aboard)):
            a, b = hhmm(min(periods[t][0] for t in aboard)), hhmm(max(periods[t][1] for t in aboard))
            if self._no_seat(v, trip, aboard, schedule, span):
                who = "un autre patient" if len(aboard) == 1 else "d'autres patients"
                return "busy", f"transporte {who} de {a} à {b}"
            whose = "son patient" if len(aboard) == 1 else "ses patients"
            return "share", f"ne peut pas la partager avec {whose} de {a} à {b} (détour ou horaires)"
        slot = schedule.break_slot
        has_break = any(self.node_at(index).role is Role.BREAK for index in route)
        during = slot is not None and slot[0] < last and slot[1] > first
        if slot is not None and has_break and during and self._fits_without_break(v, route, trip):
            return "break", f"est en pause de {hhmm(slot[0])} à {hhmm(slot[1])}"
        after = [trip_id for trip_id in periods if trip_id not in aboard and periods[trip_id][0] >= last]
        if after and self._fits_without(v, route, trip, {(following := min(after, key=lambda t: periods[t][0]))}):
            return "tight", f"ne peut pas rejoindre ensuite son arrêt de {hhmm(periods[following][0])}"
        before = [trip_id for trip_id in periods if trip_id not in aboard and periods[trip_id][1] <= first]
        if before and self._fits_without(v, route, trip, {(preceding := max(before, key=lambda t: periods[t][1]))}):
            return "tight", f"ne peut pas arriver à temps après son arrêt de {hhmm(periods[preceding][1])}"
        if slot is not None and has_break and not during and self._fits_without_break(v, route, trip):
            return "break", f"ne peut pas décaler sa pause de {hhmm(slot[0])} à {hhmm(slot[1])} pour la prendre"
        starts = [timed.start_min for timed in schedule.stops]
        earlier, later = [m for m in starts if m <= first], [m for m in starts if m >= last]
        if earlier and later:
            return "tight", f"ne peut pas l'intercaler entre ses arrêts de {hhmm(earlier[-1])} et {hhmm(later[0])}"
        return "tight", "ne peut pas l'enchaîner avec ses autres courses"

    def _fits_without(self, v: int, route: Sequence[int], trip: Trip, trip_ids: set[str]) -> bool:
        """Whether `trip` fits the route of vehicle v once these trips are out of it."""
        return self._cheapest_insertion(self._without_trips(route, trip_ids, v), v, trip) is not None

    def _fits_without_break(self, v: int, route: Sequence[int], trip: Trip) -> bool:
        """Whether `trip` fits the route of vehicle v if its driver took no break. Without the
        exact checks: schedule.py would place a break anyway, the 6 h rule (_scheduled_reasons)
        would ask for one, and the break would seem not to be in the way."""
        bare = [index for index in route if self.node_at(index).role is not Role.BREAK]
        exact, self._exact_checks = self._exact_checks, False
        try:
            return self._first_feasible(v, bare, self._insertion_positions(bare, v, trip), trip) is not None
        finally:
            self._exact_checks = exact

    def _no_seat(self, v: int, trip: Trip, aboard: Sequence[str], schedule: RouteSchedule, span: tuple[int, int]) -> bool:
        """Whether vehicle v has no seat for `trip` beside the patients `aboard` during `span`: an
        exclusive ride (theirs or the trip's, an ambulance), or every seat taken whenever someone
        is on board."""
        capacity = self.fleet[v].vehicle.capacity
        if not trip.shareable or capacity < 2 or any(not self.ctx.trips[t].shareable for t in aboard):
            return True
        first, last = span
        stops = schedule.stops
        loads = [
            timed.load_after
            for timed, following in zip(stops, stops[1:], strict=False)
            if timed.load_after and timed.start_min < last and following.start_min > first
        ]
        return bool(loads) and min(loads) >= capacity

    def _trip_ids(self, sequence: Sequence[int]) -> list[str]:
        return [node.trip.id for node in (self.node_at(index) for index in sequence) if node.trip is not None and node.role is Role.PICKUP]

    def _span_fits(self, v: int, nodes: Sequence[Node], earliest: Sequence[int], end: int) -> bool:
        """Whether the shortest timing of the route (every stop as late as the next one allows, from
        the earliest return back) fits the vehicle's work limit (model.work_limit_min)."""
        limit = self.fleet[v].work_limit
        if limit is None or not nodes:
            return True
        depot = self.nodes[v]
        latest, following = end, depot
        for node, first in zip(reversed(nodes), reversed(earliest), strict=True):
            latest = max(first, min(node.window.close, latest - self._leg(node, following) - node.service_min))
            following = node
        return end - (latest - self._leg(depot, following)) <= limit

    # -- break repair
    def _repaired(self, solution: pywrapcp.Assignment, insertion_deadline: float) -> tuple[pywrapcp.Assignment, int]:
        """The solution with a break for every vehicle that needs one, without the trips whose
        patient would ride too long or wait on board at the facility beyond their window (the
        routing model bounds neither: only the Python steps and the final check do), and with the
        trips left out reinserted; and the number of trips kept by the repair alone. The solution
        as it is if the routing model rejects the result (the local search then inserts the
        missing breaks itself)."""
        routes = self._routes(solution)
        missing = [v for v in self.break_nodes if not any(self.node_at(index).role is Role.BREAK for index in routes[v])]
        if missing:
            time_dim = self.routing.GetDimensionOrDie("Time")
            cumuls = {index: solution.Value(time_dim.CumulVar(index)) for route in routes for index in route}
            for v in missing:
                routes[v] = self._fit_break(routes[v], v, cumuls)
        on_board = 0
        for v, route in enumerate(routes):
            if breaches := self._rule_breaches(v, route):
                routes[v] = self._without_trips(route, breaches, v)
                on_board += len(breaches)
        kept = self._placed_in(routes)
        inserted = self._insert_left_out(routes, insertion_deadline)
        if not missing and not inserted and not on_board:
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
                fitted = self._with_break(self._without_trips(sequence, {trip.id}, v), v)
                if fitted is not None:
                    return fitted
            sequence = self._without_trips(sequence, {self._trip_in_the_way(pickups, v, cumuls).id}, v)

    def _with_break(self, sequence: Sequence[int], v: int) -> list[int] | None:
        """Cheapest feasible insertion of a break site of vehicle v, None if there is none. Moving the
        rest of the route later can lengthen a shared ride: the time on board is checked too."""
        return next((candidate for candidate in self._break_insertions(sequence, v) if self._fits(v, candidate)), None)

    def _fits(self, v: int, sequence: Sequence[int]) -> bool:
        """Times, work limit, time on board and wait at the facility of a route; with _exact_checks,
        on the times schedule.py reports as well."""
        if not self._time_feasible(v, sequence) or self._rule_breaches(v, sequence):
            return False
        return not self._exact_checks or not self._scheduled_breaches(v, sequence)

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
        """Exact time-window, shift and work-limit check of one route (earliest service starts)."""
        shift = self.fleet[v].shift
        previous = self.nodes[v]
        clock = shift.open
        nodes: list[Node] = []
        earliest: list[int] = []
        for index in sequence:
            node = self.node_at(index)
            clock = max(clock + previous.service_min + self._leg(previous, node), node.window.open)
            if clock > node.window.close:
                return False
            nodes.append(node)
            earliest.append(clock)
            previous = node
        clock += previous.service_min + self._leg(previous, self.nodes[v])
        return clock <= shift.close and self._span_fits(v, nodes, earliest, clock)

    def _without_trips(self, sequence: Sequence[int], trip_ids: set[str], v: int) -> list[int]:
        """Sequence of vehicle v without these trips, nor the shared rides that their removal makes
        too long (in km or on board).

        Removing stops shortens the rides through them when distances obey the triangle
        inequality; a road matrix (OSRM) may not, and an earlier stop can leave a co-passenger
        waiting on board for the next window: hence the checks.
        """
        removed = set(trip_ids)
        while True:
            kept = [index for index in sequence if (trip := self.node_at(index).trip) is None or trip.id not in removed]
            breaches = self._detour_breaches(kept) | self._rule_breaches(v, kept)
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
    def _insert_left_out(
        self, routes: list[list[int]], deadline: float, *, only: set[str] | None = None, pairs_first: bool = True
    ) -> int:
        """Put the trips missing from `routes` (changed in place), or those of `only`, back at their
        cheapest feasible position, until none fits or the deadline passes; returns the number
        inserted.

        Regret insertion: the trip with the largest gap between its best and second-best vehicle
        goes first (a trip with a single option first of all), so that the trips with few options
        are not crowded out by those that fit anywhere; with `pairs_first`, before them, a return
        whose outbound is served, then an outbound whose return is (a patient left at the facility,
        or driven back without having been driven there). An insertion makes a route tighter (only a moved break
        can free a slot): a trip without any option is not retried, and after an insertion only the
        options in the changed route are recomputed.
        """
        placed = {self.node_at(index).trip.id for route in routes for index in route if self.node_at(index).trip is not None}
        options: dict[str, dict[int, tuple[float, list[int]]]] = {}
        for trip, candidates in self.routable:
            if time.monotonic() >= deadline:
                self.insertion_cut_short = True
                return 0
            if trip.id in placed or (only is not None and trip.id not in only):
                continue
            by_vehicle = {v: best for v in candidates if (best := self._cheapest_insertion(routes[v], v, trip)) is not None}
            if by_vehicle:
                options[trip.id] = by_vehicle
        inserted = 0
        while options and time.monotonic() < deadline:
            trip_id, v = self._next_insertion(options, placed if pairs_first else set())
            routes[v] = options.pop(trip_id)[v][1]
            placed.add(trip_id)
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
        if options:
            self.insertion_cut_short = True
        return inserted

    def _partner_rank(self, trip_id: str, placed: set[str]) -> int:
        """2: a return whose outbound is served; 1: an outbound whose return is; 0 otherwise."""
        partner = self.partner.get(trip_id)
        if partner is None or partner not in placed:
            return 0
        return 2 if self.ctx.trips[trip_id].direction == "RETURN" else 1

    def _next_insertion(self, options: dict[str, dict[int, tuple[float, list[int]]]], placed: set[str]) -> tuple[str, int]:
        """(trip, vehicle) of the next insertion: the other leg of a trip of `placed` first, then
        the largest regret, then cheapest, then first listed."""
        chosen: tuple[int, float, float, str, int] | None = None
        for trip_id, by_vehicle in options.items():
            costs = sorted((cost, v) for v, (cost, _) in by_vehicle.items())
            regret = costs[1][0] - costs[0][0] if len(costs) > 1 else math.inf
            key = (self._partner_rank(trip_id, placed), regret, -costs[0][0])
            if chosen is None or key > chosen[:3]:
                chosen = (*key, trip_id, costs[0][1])
        assert chosen is not None
        return chosen[3], chosen[4]

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
            if moved is not None and not self._detour_breaches(moved) and not self._rule_breaches(v, moved):
                where = next(n for n, index in enumerate(moved) if self.node_at(index).role is Role.BREAK)
                return cost + self._stop_cost(v, moved, where) - current, moved
        return None

    def _first_feasible(
        self, v: int, route: Sequence[int], positions: Sequence[tuple[float, int, int]], trip: Trip
    ) -> tuple[float, list[int]] | None:
        """First screened position (cheapest first) that passes the full time, detour and on-board checks."""
        for cost, i, j in positions:
            sequence = self._inserted(route, trip, i, j)
            if not self._detour_breaches(sequence) and self._fits(v, sequence):
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
        minutes = self._leg(a, b) + self._leg(b, c) - self._leg(a, c)
        return km * vehicle.cost_per_km * CENTS_PER_EURO + minutes * vehicle.cost_per_hour * CENTS_PER_EURO / 60

    def _insertion_positions(self, route: Sequence[int], v: int, trip: Trip) -> list[tuple[float, int, int]]:
        """(extra cost, pickup position i, delivery position j) of every position of the trip in
        the route of vehicle v that passes the screening, cheapest first.

        The screening is exact for times (earliest starts forward, latest starts that keep the
        rest of the route on time backward), seats, exclusive rides, the empty vehicle at the break
        and the trip's own detour; only the rides of the other patients on board are left to the
        full check (_first_feasible).
        """
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
            clock = max(clock + previous.service_min + self._leg(previous, node), node.window.open)
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
            latest[k] = min(node.window.close, latest[k + 1] - self._leg(node, following) - node.service_min)
            following = node

        limit_m = self.detour_limits_m.get(trip.id)
        ride_limit = self.ride_limits[trip.id]
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
            start_p = max(departure + self._leg(before, pickup), pickup.window.open)
            if start_p > pickup.window.close:
                continue
            if (seats[i - 1] if i else 0) + pickup.seats > capacity or (exclusive[i - 1] if i else 0) + weight > EXCLUSIVE_WEIGHT:
                continue
            after_p = stops[i] if i < count else depot
            pickup_cost = extra(before, pickup, after_p)
            # Delivery right after `last` (the pickup, then each stop ridden through), before stop j.
            # `aboard`: least time on board so far (drives and stops, no wait: the pickup may be
            # delayed), a bound the time on board checked by _fits can only exceed.
            last, clock, ride, aboard = pickup, start_p, 0, 0
            for j in range(i, count + 1):
                after = stops[j] if j < count else depot
                start_d = max(clock + last.service_min + self._leg(last, delivery), delivery.window.open)
                on_time = start_d <= delivery.window.close and (start_d + delivery.service_min + self._leg(delivery, after) <= latest[j])
                short = aboard + self._leg(last, delivery) <= ride_limit
                if on_time and short and (limit_m is None or ride + self._meters(last, delivery) <= limit_m):
                    cost = extra(pickup, delivery, after_p) if j == i else extra(last, delivery, after)
                    positions.append((base + pickup_cost + cost, i, j))
                if j == count:
                    break
                # Ride through stop j with the patient on board.
                node = stops[j]
                if node.role is Role.BREAK or seats[j] + pickup.seats > capacity or exclusive[j] + weight > EXCLUSIVE_WEIGHT:
                    break
                aboard += self._leg(last, node) + node.service_min
                clock = max(clock + last.service_min + self._leg(last, node), node.window.open)
                ride += self._meters(last, node)
                if clock > node.window.close or (limit_m is not None and ride > limit_m) or aboard > ride_limit:
                    break
                last = node
        positions.sort()
        return positions

    def _meters(self, a: Node, b: Node) -> int:
        """Distance-dimension transit (meters, rounded like the model) between two nodes' places."""
        return round(self.ctx.matrix.km_by_index(a.point, b.point) * METERS_PER_KM)

    # -- result
    def sequences(self, routes: Sequence[Sequence[int]]) -> dict[str, list[StopRef]]:
        """Stops of each vehicle with trips (break nodes left out: schedule.py places the break)."""
        result: dict[str, list[StopRef]] = {}
        for v, route in enumerate(routes):
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


def _seconds_left(deadline: float, most: float) -> float:
    """Time a final pass may take: what is left before `deadline`, at most `most`, never below 0."""
    return max(0.0, min(most, deadline - time.monotonic()))


def _lawful_work_time(schedule: RouteSchedule) -> bool:
    """Route of at most 6 hours, or with a break of at least 20 min inside it (art. L. 3121-16)."""
    if schedule.duration_min <= MAX_WORK_WITHOUT_BREAK_MIN:
        return True
    slot = schedule.break_slot
    return (
        slot is not None
        and slot[1] - slot[0] >= MIN_LEGAL_BREAK_MIN
        and schedule.start_min <= slot[0]
        and slot[1] <= schedule.end_min
    )


def _label(vehicle: Vehicle) -> str:
    """A vehicle in the reason of a trip left out: its label as the planning screens write it,
    without the « » of vehicle_name (the web shows these reasons among its own lines)."""
    return vehicle.label or vehicle.id


def solve(ctx: PlanContext, initial_routes: Sequence[RoutePlan] = ()) -> SolveOutcome:
    """Routes of the day: stop sequences per vehicle and a reason for every unassigned trip.

    `initial_routes`, the plan in place (contract `initialRoutes`), is repaired to the rules of
    the request and used as a start; the plan returned never scores worse than that repaired plan
    under the objective (plan_score: the penalty per trip left out and per patient not served both
    ways, minus the margin)."""
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
    model = _DayModel(ctx, fleet, routable, initial_routes)
    build_sec = time.monotonic() - build_started
    logger.info(
        "solver: model of %d trips, %d vehicles, %d nodes built in %.2f s",
        len(routable),
        len(fleet),
        len(model.nodes),
        build_sec,
    )
    # The model build counts in the budget: on a large fleet it takes many seconds (9 s for 120
    # vehicles and 300 trips, 18 s for 480; 13 s and 28 s before November 9), which the web's
    # response margin cannot absorb.
    time_limit_sec = ctx.request.settings.time_limit_sec
    search_sec = max(time_limit_sec - build_sec, MIN_SEARCH_SEC)
    search_deadline = time.monotonic() + search_sec
    solution = model.search(search_sec)
    status_name = model.search_status
    if solution is None:
        for trip, _ in routable:
            unassigned[trip.id] = REASON_NO_SOLUTION
        return SolveOutcome({}, unassigned, "NO_SOLUTION", status_name, None, warnings)

    routes = model.routes_of(solution)
    # One budget for every final pass, those on the plan in place included (FALLBACK_SEARCH_SEC:
    # the bound of the response time). When the search returned the plan in place itself, as on a
    # re-optimization without change, the same passes would give the same plan: not run twice.
    finish_by = time.monotonic() + GUARD_SEC + PAIR_REPAIR_SEC
    warm = None if model.warm_routes is None or model.warm_routes == routes else [list(r) for r in model.warm_routes]
    left_out = model.guarded(routes, GUARD_SEC)
    model.restore_pairs(routes, _seconds_left(finish_by, PAIR_REPAIR_SEC))
    if warm is not None:
        # The search started from the plan in place among others, but what it returns can still
        # lose to it once the final checks took trips out, or on the sharing discount (outside
        # the objective): the regulator never gets a re-optimization worse than the plan in place.
        insertion_cut_short = model.insertion_cut_short
        warm_left_out = model.guarded(warm, _seconds_left(finish_by, GUARD_SEC))
        model.restore_pairs(warm, _seconds_left(finish_by, PAIR_REPAIR_SEC))
        if model.plan_score(warm) < model.plan_score(routes):
            logger.info("solver: plan in place (repaired) kept: the search found nothing better")
            routes, left_out = warm, warm_left_out
            model.start_label = "plan in place"
        else:
            # Time running out on the plan not returned says nothing of the one returned.
            model.insertion_cut_short = insertion_cut_short
    # The time the search left (a large fleet: the insertion alone, at once), at least MAKE_ROOM_SEC.
    model.make_room(routes, max(MAKE_ROOM_SEC, search_deadline - time.monotonic()))
    sequences = model.sequences(routes)
    served = {ref.trip_id for refs in sequences.values() for ref in refs}
    dropped = [trip for trip, _ in routable if trip.id not in served]
    if model.first_solution_failed and dropped:
        # Only then may a re-run place more: a complete plan from the fallback needs no warning.
        warnings.append(WARNING_FIRST_SOLUTION_FAILED)
    # After a failed first solution the plan comes from a shortened fallback search, and the
    # warning above says a re-run may place more: never tell the regulator there is no room.
    cut_short = (
        model.first_solution_failed
        or search_cut_short(status_name)
        or (model.first_solution_skipped and model.insertion_cut_short)
    )
    schedules: dict[int, RouteSchedule | None] = {}
    reasons_by = time.monotonic() + REASON_SEC
    for trip in dropped:
        if trip.id in left_out:
            unassigned[trip.id] = left_out[trip.id]
        elif cut_short:
            unassigned[trip.id] = REASON_DROPPED_TIME_LIMIT
        else:
            unassigned[trip.id] = model.left_out_reason(trip, routes, schedules, reasons_by)
    if dropped and cut_short:
        warnings.append(time_limit_warning(time_limit_sec, len(dropped), len(ctx.request.trips)))
    # Reported in cents, as before the objective moved to UNITS_PER_CENT (the final check may have
    # changed the plan since: an indication, the response recomputes every cost).
    return SolveOutcome(sequences, unassigned, "OK", status_name, float(solution.ObjectiveValue()) / UNITS_PER_CENT, warnings)


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
        f"un temps de calcul plus long (environ {recommended}\u00a0s pour {trip_count} courses) peut en placer davantage"
        if recommended > time_limit_sec
        else "un temps de calcul plus long peut en placer davantage"
    )
    return f"Recherche interrompue par la limite de {time_limit_sec}\u00a0s\u00a0: {dropped} course(s) non placée(s)\u202f; {advice}"
