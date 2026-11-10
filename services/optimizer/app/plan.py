"""Assemble a PlanResponse from ordered stop sequences (solver output or regulator plan).

Everything reported is recomputed from the sequences: times (schedule.py), km driven empty and
loaded, sharing (co-passengers), revenue of each patient's invoice (pricing.py: billed distance,
surcharges at the planned times, sharing discount, supplements), cost, margin, KPIs. The independent
validator then checks the produced routes and recomputes every invoice.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from app.context import PlanContext
from app.kpis import compute_kpis
from app.model import service_minutes
from app.pricing import Ride, cents_to_euros, revenue_cents
from app.schedule import PlannedStop, RouteSchedule, schedule_route
from app.schemas import (
    BreakSlot,
    Meta,
    PlanResponse,
    PlanStatus,
    Route,
    Stop,
    StopKind,
    StopRef,
    Trip,
    TripResult,
    Unassigned,
    Validation,
    Violation,
)
from app.validator import validate, validate_revenue

KM_DIGITS = 2
MONEY_DIGITS = 2


@dataclass
class _TripPlacement:
    """Where the stops of a trip landed in the produced routes."""

    pickup: tuple[int, int] | None = None
    """(route position in the response, stop position in the route)."""
    dropoff: tuple[int, int] | None = None
    co_passengers: set[str] = field(default_factory=set)
    ride_km: float = 0.0
    alone_km: float = 0.0
    """Part of ride_km with nobody else on board."""
    max_on_board: int = 0

    @property
    def complete(self) -> bool:
        return (
            self.pickup is not None
            and self.dropoff is not None
            and self.pickup[0] == self.dropoff[0]
            and self.pickup[1] < self.dropoff[1]
        )


@dataclass(frozen=True)
class PlanOutcome:
    """What the caller (solver run or evaluation) brings to the response."""

    sequences: Mapping[str, Sequence[StopRef]]
    unassigned_reasons: Mapping[str, str]
    default_reason: str
    status: PlanStatus
    solver_status: str
    objective: float | None
    warnings: Sequence[str] = ()
    extra_violations: Sequence[Violation] = ()


def planned_stop(ctx: PlanContext, ref: StopRef) -> PlannedStop:
    trip = ctx.trips[ref.trip_id]
    return PlannedStop(
        trip=trip,
        kind=ref.kind,
        location=trip.pickup if ref.kind == "PICKUP" else trip.dropoff,
        service_min=service_minutes(ctx.request.settings, trip, ref.kind),
        window=ctx.windows[trip.id].for_kind(ref.kind),
    )


def _wait_at_facility(trip: Trip, kind_minutes: Mapping[StopKind, int]) -> int | None:
    if trip.direction == "OUTBOUND":
        dropoff = kind_minutes.get("DROPOFF")
        if dropoff is None or trip.appointment_min is None:
            return None
        return max(0, trip.appointment_min - dropoff)
    pickup = kind_minutes.get("PICKUP")
    if pickup is None or trip.ready_min is None:
        return None
    return max(0, pickup - trip.ready_min)


def _locate_trips(schedules: Sequence[RouteSchedule]) -> dict[str, _TripPlacement]:
    placements: dict[str, _TripPlacement] = {}
    for r, schedule in enumerate(schedules):
        for s, timed in enumerate(schedule.stops):
            placement = placements.setdefault(timed.stop.trip.id, _TripPlacement())
            if timed.stop.kind == "PICKUP" and placement.pickup is None:
                placement.pickup = (r, s)
            elif timed.stop.kind == "DROPOFF" and placement.dropoff is None:
                placement.dropoff = (r, s)
    for trip_id, placement in placements.items():
        if not placement.complete:
            continue
        assert placement.pickup is not None and placement.dropoff is not None
        schedule = schedules[placement.pickup[0]]
        # Leg k + 1 goes from stop k to stop k + 1.
        ride_legs = schedule.legs[placement.pickup[1] + 1 : placement.dropoff[1] + 1]
        placement.ride_km = sum(leg.km for leg in ride_legs)
        placement.alone_km = sum(leg.km for leg in ride_legs if leg.on_board == {trip_id})
        placement.max_on_board = max((len(leg.on_board) for leg in ride_legs), default=1)
        for leg in ride_legs:
            placement.co_passengers.update(leg.on_board)
        placement.co_passengers.discard(trip_id)
    return placements


def _empty_leg(ctx: PlanContext, trip: Trip, schedule: RouteSchedule, placement: _TripPlacement) -> bool:
    """settings.pricing.emptyLeg DEPOT: the outbound trip whose dropoff ends the route (the vehicle
    drives back empty to its station), the return trip whose pickup starts it (it came empty)."""
    if ctx.request.settings.pricing.empty_leg != "DEPOT" or not trip.hospital_linked:
        return False
    assert placement.pickup is not None and placement.dropoff is not None
    if trip.direction == "OUTBOUND":
        return placement.dropoff[1] == len(schedule.stops) - 1
    return placement.pickup[1] == 0


def _revenue_cents(ctx: PlanContext, trip: Trip, schedules: Sequence[RouteSchedule], placement: _TripPlacement) -> int:
    """Invoice of a trip served by the routes (cents): pricing.py on the planned stops."""
    assert placement.pickup is not None and placement.dropoff is not None
    schedule = schedules[placement.pickup[0]]
    ride = Ride(
        direct_km=ctx.direct_km(trip),
        ride_km=placement.ride_km,
        alone_km=placement.alone_km,
        co_passengers=len(placement.co_passengers),
        max_on_board=placement.max_on_board,
        pickup_min=schedule.stops[placement.pickup[1]].start_min,
        dropoff_min=schedule.stops[placement.dropoff[1]].start_min,
        empty_leg=_empty_leg(ctx, trip, schedule, placement),
    )
    return revenue_cents(ctx.tariffs, trip, schedule.vehicle, ride, ctx.request.settings.pricing, ctx.calendar)


def _schedules(ctx: PlanContext, sequences: Mapping[str, Sequence[StopRef]]) -> list[RouteSchedule]:
    """Timed routes of the vehicles with stops, in the request's vehicle order."""
    schedules: list[RouteSchedule] = []
    for vehicle in ctx.request.vehicles:
        refs = sequences.get(vehicle.id, ())
        if refs:
            schedules.append(schedule_route(vehicle, [planned_stop(ctx, ref) for ref in refs], ctx.matrix))
    return schedules


def _route_cost(schedule: RouteSchedule) -> float:
    """km x costPerKm + hours x costPerHour of a timed route."""
    vehicle = schedule.vehicle
    return schedule.distance_km * vehicle.cost_per_km + schedule.duration_min / 60 * vehicle.cost_per_hour


def plan_margin(ctx: PlanContext, sequences: Mapping[str, Sequence[StopRef]]) -> tuple[float, set[str]]:
    """Margin of the sequences as build_response reports it (each invoice as pricing.py prices it,
    minus the cost of the routes, unrounded) and the trips they serve, without the validation:
    how the solver compares two finished plans."""
    schedules = _schedules(ctx, sequences)
    served: set[str] = set()
    revenue = 0
    for trip_id, placement in _locate_trips(schedules).items():
        if not placement.complete:
            continue
        served.add(trip_id)
        revenue += _revenue_cents(ctx, ctx.trips[trip_id], schedules, placement)
    return cents_to_euros(revenue) - sum(_route_cost(schedule) for schedule in schedules), served


def _placed_result(
    ctx: PlanContext, trip: Trip, placement: _TripPlacement, schedules: Sequence[RouteSchedule]
) -> tuple[TripResult, int, int]:
    """Result of a trip found in the routes, its invoice (cents, 0 unless picked up and dropped off
    on one route) and the position of the route it belongs to."""
    direct_km = ctx.direct_km(trip)
    anchor = placement.pickup or placement.dropoff
    assert anchor is not None
    schedule = schedules[anchor[0]]
    minutes: dict[StopKind, int] = {}
    if placement.pickup is not None:
        minutes["PICKUP"] = schedules[placement.pickup[0]].stops[placement.pickup[1]].start_min
    if placement.dropoff is not None:
        minutes["DROPOFF"] = schedules[placement.dropoff[0]].stops[placement.dropoff[1]].start_min
    revenue = _revenue_cents(ctx, trip, schedules, placement) if placement.complete else 0
    result = TripResult(
        trip_id=trip.id,
        vehicle_id=schedule.vehicle.id,
        pickup_min=minutes.get("PICKUP"),
        dropoff_min=minutes.get("DROPOFF"),
        shared=bool(placement.co_passengers),
        co_passenger_trip_ids=sorted(placement.co_passengers),
        direct_km=round(direct_km, KM_DIGITS),
        ride_km=round(placement.ride_km, KM_DIGITS),
        detour_km=round(max(0.0, placement.ride_km - direct_km), KM_DIGITS) if placement.complete else 0.0,
        revenue=cents_to_euros(revenue),
        wait_at_facility_min=_wait_at_facility(trip, minutes),
    )
    return result, revenue, anchor[0]


def route_results(ctx: PlanContext, sequences: Mapping[str, Sequence[StopRef]]) -> tuple[list[Route], list[TripResult]]:
    """The routes of these sequences and the results of the trips they carry (request order), timed
    and priced exactly as build_response reports them, without the rest of the day: the routes an
    insertion changes (app/insertion.py)."""
    schedules = _schedules(ctx, sequences)
    placements = _locate_trips(schedules)
    route_revenue = [0] * len(schedules)
    results: list[TripResult] = []
    for trip in ctx.request.trips:
        placement = placements.get(trip.id)
        if placement is None:
            continue
        result, revenue, r = _placed_result(ctx, trip, placement, schedules)
        route_revenue[r] += revenue
        results.append(result)
    return [_route_model(schedule, cents_to_euros(route_revenue[r])) for r, schedule in enumerate(schedules)], results


def build_response(ctx: PlanContext, outcome: PlanOutcome, started_at: float) -> PlanResponse:
    """PlanResponse of the given sequences; `started_at` is a time.perf_counter() value."""
    schedules = _schedules(ctx, outcome.sequences)
    placements = _locate_trips(schedules)
    trip_results: list[TripResult] = []
    route_revenue = [0] * len(schedules)
    """Cents."""
    unassigned: list[Unassigned] = []
    for trip in ctx.request.trips:
        placement = placements.get(trip.id)
        if placement is None:
            unassigned.append(
                Unassigned(trip_id=trip.id, reason=outcome.unassigned_reasons.get(trip.id, outcome.default_reason))
            )
            trip_results.append(
                TripResult(
                    trip_id=trip.id,
                    vehicle_id=None,
                    pickup_min=None,
                    dropoff_min=None,
                    shared=False,
                    co_passenger_trip_ids=[],
                    direct_km=round(ctx.direct_km(trip), KM_DIGITS),
                    ride_km=0.0,
                    detour_km=0.0,
                    revenue=0.0,
                    wait_at_facility_min=None,
                )
            )
            continue
        result, revenue, r = _placed_result(ctx, trip, placement, schedules)
        route_revenue[r] += revenue
        trip_results.append(result)

    routes = [_route_model(schedule, cents_to_euros(route_revenue[r])) for r, schedule in enumerate(schedules)]
    violations = [
        *outcome.extra_violations,
        *validate(ctx.request, routes, ctx.matrix),
        *validate_revenue(ctx.request, routes, trip_results, ctx.matrix),
    ]
    warnings = list(outcome.warnings)
    return PlanResponse(
        status=outcome.status,
        routes=routes,
        trips=trip_results,
        unassigned=unassigned,
        kpis=compute_kpis(len(ctx.request.trips), routes, trip_results),
        validation=Validation(valid=not violations, violations=violations),
        meta=Meta(
            matrix_source=ctx.matrix.source,
            traffic_source=ctx.matrix.traffic_source,
            solver_status=outcome.solver_status,
            objective=outcome.objective,
            wall_time_ms=round((time.perf_counter() - started_at) * 1000),
            warnings=warnings,
        ),
    )


def _route_model(schedule: RouteSchedule, revenue: float) -> Route:
    vehicle = schedule.vehicle
    distance = round(schedule.distance_km, KM_DIGITS)
    empty = round(schedule.empty_km, KM_DIGITS)
    cost = _route_cost(schedule)
    slot = schedule.break_slot
    return Route(
        vehicle_id=vehicle.id,
        start_min=schedule.start_min,
        end_min=schedule.end_min,
        distance_km=distance,
        empty_km=empty,
        loaded_km=round(distance - empty, KM_DIGITS),
        duration_min=schedule.duration_min,
        revenue=round(revenue, MONEY_DIGITS),
        cost=round(cost, MONEY_DIGITS),
        margin=round(revenue - cost, MONEY_DIGITS),
        break_=BreakSlot(start_min=slot[0], end_min=slot[1]) if slot else None,
        stops=[
            Stop(
                trip_id=timed.stop.trip.id,
                kind=timed.stop.kind,
                location=timed.stop.location,
                arrival_min=timed.arrival_min,
                start_min=timed.start_min,
                departure_min=timed.departure_min,
                load_after=timed.load_after,
            )
            for timed in schedule.stops
        ],
    )
