"""Timing of a given stop sequence for one vehicle.

Used by /evaluate (the regulator's sequence) and to report /optimize results: the solver only
decides the order of the stops, every reported time, km and load is recomputed here.

1. Forward pass: earliest service start of each stop (wait for the window to open).
2. Backward pass over the legs driven with patients on board: the stop before such a leg is
   delayed as much as its successor allows (never past its own window close), so the vehicle does
   not wait with patients on board. Arrivals at the facility keep their earliest time (margin before
   the appointment), the route end stays the earliest possible, and the depot departure is as late
   as possible without delaying the first stop (never before the shift start).
3. Driver break: tried before the depot departure, on every leg driven empty (no patient on
   board, depot legs included) and after the return. The placement with the least lateness, then
   one that keeps a route of more than 6 hours legal (a break of at least 20 min inside it, Code du
   travail art. L3121-16), then the shortest route, then the earliest break wins. On a leg the
   driver may drive first and rest at the next stop, or rest on the way when the window closes
   before the arrival. A break that would make patients later than without it is not placed
   (reported as a missing break).
4. A route still longer than 6 hours without a legal break inside it (no break rule, or one that
   falls before the departure or after the return) is timed compact instead: every stop as late as
   the next one allows, from the earliest return back, so that the depot departure is as late as
   possible. The solver caps such routes at 6 hours on that timing (model.work_limit_min).

The vehicle may still wait with a patient on board where a window closes before the next one
opens (a return picked up at the end of its window, the next patient of the same facility ready
later): the validator counts that wait at the facility in the patient's wait (TOTAL_WAIT) and the
time on board against the direct drive (RIDE_TIME); the solver keeps both within their limits.

Lateness (service after the window close, return after the shift end) is not hidden: it is kept in
the times so that the validator reports it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum

from app.matrix import TravelMatrix
from app.model import MAX_WORK_WITHOUT_BREAK_MIN, MIN_LEGAL_BREAK_MIN, Window
from app.schemas import BreakRule, LatLng, StopKind, Trip, Vehicle
from app.traffic import stop_reference_minute


@dataclass(frozen=True)
class PlannedStop:
    """A stop to schedule: which trip, pickup or dropoff, where, how long, and when allowed."""

    trip: Trip
    kind: StopKind
    location: LatLng
    service_min: int
    window: Window


@dataclass(frozen=True)
class TimedStop:
    stop: PlannedStop
    arrival_min: int
    start_min: int
    departure_min: int
    load_after: int


@dataclass(frozen=True)
class Leg:
    """Drive between two consecutive points of the route (depot legs included)."""

    km: float
    minutes: int
    on_board: frozenset[str]
    """Trip ids of the patients on board while driving it."""

    @property
    def empty(self) -> bool:
        return not self.on_board


@dataclass(frozen=True)
class RouteSchedule:
    vehicle: Vehicle
    stops: tuple[TimedStop, ...]
    legs: tuple[Leg, ...]
    """len(stops) + 1 legs: depot -> first stop, ..., last stop -> depot."""
    start_min: int
    end_min: int
    break_slot: tuple[int, int] | None
    lateness_min: int

    @property
    def distance_km(self) -> float:
        return sum(leg.km for leg in self.legs)

    @property
    def empty_km(self) -> float:
        return sum(leg.km for leg in self.legs if leg.empty)

    @property
    def duration_min(self) -> int:
        return self.end_min - self.start_min


class _Where(Enum):
    NONE = "none"
    BEFORE = "before"
    LEG = "leg"
    AFTER = "after"


@dataclass(frozen=True)
class _Placement:
    where: _Where
    leg: int = -1

    def on_leg(self, leg: int) -> bool:
        return self.where is _Where.LEG and self.leg == leg


def _ready_after_leg_with_break(departure: int, travel: int, rule: BreakRule) -> int | None:
    """Earliest time the vehicle can serve the next stop when the break is taken on this leg,
    None when the break window is over before the vehicle can stop."""
    ws, we, d = rule.window_start_min, rule.window_end_min, rule.duration_min
    if departure > we - d:
        return None
    return max(departure + travel, ws) + d


def _break_start_on_leg(departure: int, travel: int, rule: BreakRule) -> int:
    """Break start on a leg: at the next stop after driving when possible, else on the way."""
    return min(max(departure + travel, rule.window_start_min), rule.window_end_min - rule.duration_min)


def _load_profile(stops: Sequence[PlannedStop]) -> tuple[list[int], list[frozenset[str]]]:
    """Patients on board after each stop, and the on-board set of each leg."""
    on_board: set[str] = set()
    loads: list[int] = []
    leg_sets: list[frozenset[str]] = [frozenset()]
    for stop in stops:
        if stop.kind == "PICKUP":
            on_board.add(stop.trip.id)
        else:
            on_board.discard(stop.trip.id)
        loads.append(len(on_board))
        leg_sets.append(frozenset(on_board))
    return loads, leg_sets


@dataclass(frozen=True)
class _Run:
    stops: tuple[TimedStop, ...]
    start_min: int
    end_min: int
    break_slot: tuple[int, int] | None
    lateness_min: int

    @property
    def lawful(self) -> bool:
        """At most MAX_WORK_WITHOUT_BREAK_MIN of route, or a break of MIN_LEGAL_BREAK_MIN inside it."""
        if self.end_min - self.start_min <= MAX_WORK_WITHOUT_BREAK_MIN:
            return True
        slot = self.break_slot
        return (
            slot is not None
            and slot[1] - slot[0] >= MIN_LEGAL_BREAK_MIN
            and self.start_min <= slot[0]
            and slot[1] <= self.end_min
        )

    def rank(self, order: int) -> tuple[int, int, int, int, int]:
        """Least lateness, then lawful work time, then shortest route, then earliest break."""
        begin = self.break_slot[0] if self.break_slot else 0
        return (self.lateness_min, 0 if self.lawful else 1, self.end_min - self.start_min, begin, order)


class _Timing:
    """Forward/backward passes of one sequence for one break placement."""

    def __init__(self, vehicle: Vehicle, stops: Sequence[PlannedStop], travel: Sequence[int]) -> None:
        self.vehicle = vehicle
        self.stops = stops
        self.travel = travel

    def _rule(self) -> BreakRule:
        rule = self.vehicle.break_
        assert rule is not None
        return rule

    def _forward(self, placement: _Placement) -> tuple[list[int], int] | None:
        """Earliest service starts and route end, None if the placement is impossible."""
        dep = self.vehicle.shift_start_min
        if placement.where is _Where.BEFORE:
            rule = self._rule()
            dep = max(dep, rule.window_start_min + rule.duration_min)
        earliest: list[int] = []
        for k, stop in enumerate(self.stops):
            ready = self._ready(placement, k, dep)
            if ready is None:
                return None
            start = max(ready, stop.window.open)
            earliest.append(start)
            dep = start + stop.service_min
        end = self._ready(placement, len(self.stops), dep)
        if end is None:
            return None
        if placement.where is _Where.AFTER:
            rule = self._rule()
            if max(rule.window_start_min, end) + rule.duration_min > rule.window_end_min:
                return None
        return earliest, end

    def _ready(self, placement: _Placement, leg: int, departure: int) -> int | None:
        travel = self.travel[leg]
        if placement.on_leg(leg):
            return _ready_after_leg_with_break(departure, travel, self._rule())
        return departure + travel

    def _latest_departure(self, placement: _Placement, leg: int, next_start: int) -> int:
        """Latest departure on `leg` that still reaches the next point by `next_start`."""
        travel = self.travel[leg]
        if placement.on_leg(leg):
            rule = self._rule()
            return min(next_start - travel - rule.duration_min, rule.window_end_min - rule.duration_min)
        return next_start - travel

    def run(self, placement: _Placement, loads: Sequence[int], *, compact: bool = False) -> _Run | None:
        """Times of the sequence with the break at `placement`, None if it cannot go there.

        `compact` (never with a break on a leg): every stop as late as the next one allows, from the
        earliest return back, so that the route is as short as its windows allow.
        """
        forward = self._forward(placement)
        if forward is None:
            return None
        earliest, end = forward
        count = len(self.stops)

        # Backward pass across loaded legs only: a stop followed by a patient on board is delayed
        # so that the vehicle does not wait with them; facility arrivals keep their margin.
        starts = list(earliest)
        for k in reversed(range(count)):
            if k == count - 1 and not compact:
                continue
            if loads[k] == 0 and not compact:
                continue
            stop = self.stops[k]
            following = starts[k + 1] if k + 1 < count else end
            latest_start = min(stop.window.close, self._latest_departure(placement, k + 1, following) - stop.service_min)
            starts[k] = max(earliest[k], latest_start)

        lower = self.vehicle.shift_start_min
        if placement.where is _Where.BEFORE:
            rule = self._rule()
            lower = max(lower, rule.window_start_min + rule.duration_min)
        start_min = max(lower, self._latest_departure(placement, 0, starts[0])) if count else lower

        timed: list[TimedStop] = []
        break_slot: tuple[int, int] | None = None
        dep = start_min
        for k, stop in enumerate(self.stops):
            arrival, ready, slot = self._drive(placement, k, dep)
            break_slot = slot or break_slot
            start = max(starts[k], ready)
            timed.append(TimedStop(stop, arrival, start, start + stop.service_min, loads[k]))
            dep = start + stop.service_min
        _, end_min, slot = self._drive(placement, count, dep)
        break_slot = slot or break_slot

        if placement.where is _Where.BEFORE:
            rule = self._rule()
            break_slot = (rule.window_start_min, rule.window_start_min + rule.duration_min)
        elif placement.where is _Where.AFTER:
            rule = self._rule()
            begin = max(rule.window_start_min, end_min)
            break_slot = (begin, begin + rule.duration_min)

        lateness = sum(max(0, t.start_min - t.stop.window.close) for t in timed)
        lateness += max(0, end_min - self.vehicle.shift_end_min)
        return _Run(tuple(timed), start_min, end_min, break_slot, lateness)

    def _drive(self, placement: _Placement, leg: int, departure: int) -> tuple[int, int, tuple[int, int] | None]:
        """(physical arrival, ready to serve, break slot) for a leg driven from `departure`."""
        travel = self.travel[leg]
        if not placement.on_leg(leg):
            return departure + travel, departure + travel, None
        rule = self._rule()
        begin = _break_start_on_leg(departure, travel, rule)
        arrival = departure + travel if begin >= departure + travel else departure + travel + rule.duration_min
        ready = max(departure + travel, begin) + rule.duration_min
        return arrival, ready, (begin, begin + rule.duration_min)


def _compact_if_lawful(timing: _Timing, chosen: _Run, candidates: Sequence[_Placement], loads: Sequence[int]) -> _Run:
    """The compact timing of a route too long without a legal break, when it makes the route
    lawful without more lateness (the break, if any, before the departure or after the return)."""
    off_route = [_Placement(_Where.NONE), *(p for p in candidates if p.where is not _Where.LEG)]
    lawful = [
        (run, order)
        for order, placement in enumerate(off_route)
        if (run := timing.run(placement, loads, compact=True)) and run.lawful and run.lateness_min <= chosen.lateness_min
    ]
    if not lawful:
        return chosen
    # A break rule placed off-route beats no break at all (rank: earliest break last, NONE first).
    return min(lawful, key=lambda item: (item[0].lateness_min, item[0].break_slot is None, item[1]))[0]


def schedule_route(vehicle: Vehicle, stops: Sequence[PlannedStop], matrix: TravelMatrix) -> RouteSchedule:
    """Times, loads and legs of `stops` driven in this order by `vehicle` from and to its depot."""
    points = [vehicle.depot, *(stop.location for stop in stops), vehicle.depot]
    references = [None, *(stop_reference_minute(stop.trip, stop.kind, matrix) for stop in stops), None]
    legs_km = [matrix.km(a, b) for a, b in zip(points, points[1:], strict=False)]
    travel = [matrix.leg(points[k], points[k + 1], references[k], references[k + 1]) for k in range(len(points) - 1)]
    loads, leg_sets = _load_profile(stops)
    legs = tuple(Leg(km, minutes, on_board) for km, minutes, on_board in zip(legs_km, travel, leg_sets, strict=True))

    timing = _Timing(vehicle, stops, travel)
    rule = vehicle.break_
    candidates: list[_Placement] = []
    if rule is not None and rule.duration_min > 0:
        candidates.append(_Placement(_Where.BEFORE))
        candidates.extend(_Placement(_Where.LEG, k) for k, leg in enumerate(legs) if leg.empty)
        candidates.append(_Placement(_Where.AFTER))

    runs = [(run, order) for order, placement in enumerate(candidates) if (run := timing.run(placement, loads))]
    without_break = timing.run(_Placement(_Where.NONE), loads)
    assert without_break is not None  # without a break every sequence has a timing
    chosen = without_break
    if runs:
        best = min(runs, key=lambda item: item[0].rank(item[1]))[0]
        # Patients first: a break that would make the plan later than it is without it is not
        # placed (the validator then reports the missing break).
        if best.lateness_min <= without_break.lateness_min:
            chosen = best
    if not chosen.lawful:
        chosen = _compact_if_lawful(timing, chosen, candidates, loads)
    return RouteSchedule(
        vehicle=vehicle,
        stops=chosen.stops,
        legs=legs,
        start_min=chosen.start_min,
        end_min=chosen.end_min,
        break_slot=chosen.break_slot,
        lateness_min=chosen.lateness_min,
    )
