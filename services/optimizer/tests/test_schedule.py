"""Timing of a fixed stop sequence: earliest feasible service, no waiting with patients on board,
latest depot departure, and driver break placement."""

from __future__ import annotations

from typing import Any

from app.context import PlanContext, make_context, request_points
from app.matrix import build_matrix
from app.plan import planned_stop
from app.schedule import RouteSchedule, schedule_route
from app.schemas import OptimizeRequest, StopRef
from tests.builders import AIX, GAP, MARSEILLE, offset, request, trip, vehicle

HOME = offset(MARSEILLE, 2, 1)
BREAK_RULE = {"windowStartMin": 690, "windowEndMin": 840, "durationMin": 45}


def context(trips: list[dict[str, Any]], break_: dict[str, int] | None = None) -> PlanContext:
    raw = request([vehicle("taxi", MARSEILLE, break_=break_)], trips)
    parsed = OptimizeRequest.model_validate(raw)
    matrix, _ = build_matrix(request_points(parsed))
    return make_context(parsed, matrix)


def run(ctx: PlanContext, stops: list[tuple[str, str]]) -> RouteSchedule:
    planned = [planned_stop(ctx, StopRef(trip_id=t, kind=k)) for t, k in stops]  # type: ignore[arg-type]
    return schedule_route(ctx.request.vehicles[0], planned, ctx.matrix)


def test_outbound_arrives_in_window_without_waiting_on_board() -> None:
    ctx = context([trip("out", "p", "OUTBOUND", HOME, AIX, appointment=480)])
    route = run(ctx, [("out", "PICKUP"), ("out", "DROPOFF")])
    pickup, dropoff = route.stops
    out, depot = ctx.trips["out"], ctx.request.vehicles[0].depot
    ride = ctx.matrix.minutes(out.pickup, out.dropoff)
    approach = ctx.matrix.minutes(depot, out.pickup)
    assert dropoff.start_min == 450  # window opens 30 min before the appointment
    assert dropoff.arrival_min == dropoff.start_min  # the pickup was delayed instead
    assert pickup.start_min == 450 - 5 - ride
    assert route.start_min == pickup.start_min - approach  # latest departure
    assert route.end_min == dropoff.departure_min + ctx.matrix.minutes(out.dropoff, depot)
    assert [s.load_after for s in route.stops] == [1, 0]
    assert route.lateness_min == 0
    assert route.empty_km == route.legs[0].km + route.legs[2].km
    assert route.distance_km == sum(leg.km for leg in route.legs)


def test_return_waits_for_the_end_of_session() -> None:
    ctx = context([trip("ret", "p", "RETURN", AIX, HOME, ready=690)])
    route = run(ctx, [("ret", "PICKUP"), ("ret", "DROPOFF")])
    pickup = route.stops[0]
    assert pickup.start_min == 690
    assert pickup.arrival_min == pickup.start_min  # leaves the depot just in time
    assert route.start_min >= ctx.request.vehicles[0].shift_start_min


def test_break_on_an_empty_leg_inside_the_window() -> None:
    ctx = context(
        [
            trip("a", "p1", "OUTBOUND", HOME, AIX, appointment=600),
            trip("b", "p2", "RETURN", AIX, HOME, ready=780),
        ],
        BREAK_RULE,
    )
    route = run(ctx, [("a", "PICKUP"), ("a", "DROPOFF"), ("b", "PICKUP"), ("b", "DROPOFF")])
    assert route.break_slot is not None
    start, end = route.break_slot
    assert end - start == 45 and 690 <= start and end <= 840
    a_dropoff, b_pickup = route.stops[1], route.stops[2]
    assert a_dropoff.departure_min <= start and end <= b_pickup.start_min  # empty vehicle, between stops
    assert route.lateness_min == 0


def test_break_after_a_morning_route() -> None:
    ctx = context([trip("out", "p", "OUTBOUND", HOME, AIX, appointment=480)], BREAK_RULE)
    route = run(ctx, [("out", "PICKUP"), ("out", "DROPOFF")])
    assert route.break_slot == (690, 735)
    assert route.end_min < 690


def test_no_break_when_a_patient_is_on_board_all_window() -> None:
    tight = {"windowStartMin": 690, "windowEndMin": 760, "durationMin": 45}
    ctx = context([trip("long", "p", "RETURN", GAP, HOME, ready=690)], tight)
    route = run(ctx, [("long", "PICKUP"), ("long", "DROPOFF")])
    assert route.break_slot is None  # patients first: the validator reports the missing break
    assert route.lateness_min == 0


def test_lateness_is_kept_visible() -> None:
    ctx = context([trip("late", "p", "OUTBOUND", GAP, AIX, appointment=400)])
    route = run(ctx, [("late", "PICKUP"), ("late", "DROPOFF")])
    assert route.stops[1].start_min > 400
    assert route.lateness_min == route.stops[1].start_min - 400
