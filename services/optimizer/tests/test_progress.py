"""A day under way (contract `progress`, app/progress.py): the stops done never change and head their
routes at their real times, nothing still to do is planned before the request's minute, a patient on
board is always dropped by their vehicle, their ride re-checked from their real pickup; « Où placer »
and /evaluate on a started day; the change penalty keeps the plan in place for a small gain."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from pydantic import ValidationError

from app import service
from app.context import request_points
from app.matrix import build_matrix
from app.schemas import EvaluateRequest, InsertRequest, OptimizeRequest, PlanResponse, Route
from app.validator import validate
from tests.builders import AIX, MARSEILLE, load_fixture, offset, request, trip, vehicle

Json = dict[str, Any]


def morning_day() -> Json:
    """Two Marseille taxis (no break), five outbound trips through the morning and a return."""
    home = [offset(MARSEILLE, 2 * k, 1 + k) for k in range(6)]
    clinic = offset(MARSEILLE, -3, 2)
    trips = [
        trip("t1", "p1", "OUTBOUND", home[0], clinic, appointment=480),
        trip("t2", "p2", "OUTBOUND", home[1], clinic, appointment=540),
        trip("t3", "p3", "OUTBOUND", home[2], clinic, appointment=600),
        trip("t4", "p4", "OUTBOUND", home[3], clinic, appointment=660),
        trip("t5", "p5", "OUTBOUND", home[4], clinic, appointment=720, shareable=False),
        trip("t6", "p6", "RETURN", clinic, home[5], ready=750),
    ]
    vehicles = [vehicle("taxi_1", MARSEILLE, shift=(420, 1080)), vehicle("taxi_2", MARSEILLE, shift=(420, 1080))]
    return request(vehicles, trips, timeLimitSec=2)


def routes_of(plan: PlanResponse) -> list[Json]:
    return [{"vehicleId": r.vehicle_id, "stops": [{"tripId": s.trip_id, "kind": s.kind} for s in r.stops]} for r in plan.routes]


def done_stops(plan: PlanResponse, vehicle_id: str, count: int, late: int = 0) -> list[Json]:
    """The first `count` stops of the vehicle's route, done at their planned times (plus `late` minutes)."""
    route = next(r for r in plan.routes if r.vehicle_id == vehicle_id)
    return [
        {"tripId": s.trip_id, "kind": s.kind, "startMin": s.start_min + late, "departureMin": s.departure_min + late}
        for s in route.stops[:count]
    ]


def started(raw: Json, plan: PlanResponse, now: int, done: dict[str, list[Json]], **extra: Any) -> Json:
    progress = {"nowMin": now, "routes": [{"vehicleId": vid, "done": stops} for vid, stops in done.items()]}
    return {**copy.deepcopy(raw), "progress": progress, "initialRoutes": routes_of(plan), **extra}


@pytest.fixture(scope="module")
def planned() -> tuple[Json, PlanResponse]:
    raw = morning_day()
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.kpis.trips_served == 6
    return raw, plan


def route(plan: PlanResponse, vehicle_id: str) -> Any:
    return next(r for r in plan.routes if r.vehicle_id == vehicle_id)


def test_progress_is_checked_against_the_request() -> None:
    raw = morning_day()
    good = {"nowMin": 600, "routes": [{"vehicleId": "taxi_1", "done": [{"tripId": "t1", "kind": "PICKUP", "startMin": 450, "departureMin": 455}]}]}
    assert OptimizeRequest.model_validate({**raw, "progress": good}).progress is not None
    for bad in (
        {"nowMin": 600, "routes": [{"vehicleId": "taxi_9", "done": []}]},
        {"nowMin": 600, "routes": [{"vehicleId": "taxi_1", "done": [{"tripId": "t9", "kind": "PICKUP", "startMin": 450, "departureMin": 455}]}]},
        {"nowMin": 600, "routes": [{"vehicleId": "taxi_1", "done": [{"tripId": "t1", "kind": "DROPOFF", "startMin": 450, "departureMin": 455}]}]},
        {"nowMin": 600, "routes": [{"vehicleId": "taxi_1", "done": [{"tripId": "t1", "kind": "PICKUP", "startMin": 450, "departureMin": 440}]}]},
        {"nowMin": 600, "routes": [{"vehicleId": "taxi_1", "done": []}, {"vehicleId": "taxi_1", "done": []}]},
    ):
        with pytest.raises(ValidationError):
            OptimizeRequest.model_validate({**raw, "progress": bad})


def test_the_contract_fixture_of_a_started_day_is_planned_from_its_start() -> None:
    raw = load_fixture("optimize-request-started.json")
    request_ = OptimizeRequest.model_validate(raw)
    assert request_.progress is not None
    plan = service.optimize(request_)
    now = request_.progress.now_min
    for started_route in request_.progress.routes:
        stops = route(plan, started_route.vehicle_id).stops
        assert [(s.trip_id, s.kind, s.start_min) for s in stops[: len(started_route.done)]] == [
            (d.trip_id, d.kind, d.start_min) for d in started_route.done
        ]
        assert all(s.start_min >= now for s in stops[len(started_route.done) :])
    ambulance = route(plan, "veh_amb_1").stops
    assert ("trip_5", "DROPOFF") in [(s.trip_id, s.kind) for s in ambulance[1:]]
    assert "trip_5" not in {u.trip_id for u in plan.unassigned}


def test_the_stops_done_head_the_route_at_their_real_times_and_the_rest_comes_after_now(planned: tuple[Json, PlanResponse]) -> None:
    raw, plan = planned
    vid = route(plan, "taxi_1").vehicle_id if route(plan, "taxi_1").stops else "taxi_2"
    done = done_stops(plan, vid, 2, late=3)
    now = done[-1]["departureMin"] + 20
    replanned = service.optimize(OptimizeRequest.model_validate(started(raw, plan, now, {vid: done})))
    stops = route(replanned, vid).stops
    assert [(s.trip_id, s.kind, s.start_min, s.departure_min) for s in stops[:2]] == [
        (d["tripId"], d["kind"], d["startMin"], d["departureMin"]) for d in done
    ]
    for r in replanned.routes:
        own = len(done) if r.vehicle_id == vid else 0
        assert all(s.start_min >= now for s in r.stops[own:]), r.vehicle_id
    # The trip done is served (on its route), never unassigned.
    assert done[0]["tripId"] not in {u.trip_id for u in replanned.unassigned}


def test_a_patient_on_board_is_dropped_by_their_vehicle(planned: tuple[Json, PlanResponse]) -> None:
    raw, plan = planned
    vid = "taxi_1" if route(plan, "taxi_1").stops else "taxi_2"
    stops = route(plan, vid).stops
    first_pickup = next(k for k, s in enumerate(stops) if s.kind == "PICKUP")
    done = done_stops(plan, vid, first_pickup + 1)
    on_board = done[-1]["tripId"]
    now = done[-1]["departureMin"] + 2
    replanned = service.optimize(OptimizeRequest.model_validate(started(raw, plan, now, {vid: done})))
    mine = route(replanned, vid).stops
    assert any(s.trip_id == on_board and s.kind == "DROPOFF" for s in mine[len(done) :])
    assert all(not (s.trip_id == on_board) for r in replanned.routes if r.vehicle_id != vid for s in r.stops)
    assert on_board not in {u.trip_id for u in replanned.unassigned}
    # The load after the stops done counts the patient on board.
    assert mine[len(done) - 1].load_after >= 1


def test_a_late_patient_on_board_is_still_dropped_and_the_lateness_reported() -> None:
    raw = morning_day()
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    vid = next(r.vehicle_id for r in plan.routes if any(s.trip_id == "t1" for s in r.stops))
    pickup = next(s for s in route(plan, vid).stops if s.trip_id == "t1" and s.kind == "PICKUP")
    # Picked up 60 minutes late: the 08:00 appointment can no longer be kept.
    done = [{"tripId": "t1", "kind": "PICKUP", "startMin": pickup.start_min + 60, "departureMin": pickup.departure_min + 60}]
    now = pickup.departure_min + 61
    replanned = service.optimize(OptimizeRequest.model_validate(started(raw, plan, now, {vid: done})))
    assert "t1" not in {u.trip_id for u in replanned.unassigned}
    dropoff = next(s for s in route(replanned, vid).stops if s.trip_id == "t1" and s.kind == "DROPOFF")
    assert dropoff.start_min > 480
    assert any(v.code == "TIME_WINDOW" and v.trip_id == "t1" for v in replanned.validation.violations)


def test_the_validator_does_not_judge_the_stops_done() -> None:
    raw = morning_day()
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    vid = next(r.vehicle_id for r in plan.routes if any(s.trip_id == "t1" for s in r.stops))
    stops = route(plan, vid).stops
    t1 = [s for s in stops if s.trip_id == "t1"]
    # Driven 40 min late (after its appointment) and faster than the matrix: facts, not violations of the plan.
    done = [
        {"tripId": "t1", "kind": "PICKUP", "startMin": t1[0].start_min + 40, "departureMin": t1[0].departure_min + 40},
        {"tripId": "t1", "kind": "DROPOFF", "startMin": t1[0].departure_min + 41, "departureMin": t1[0].departure_min + 46},
    ]
    now = done[-1]["departureMin"] + 5
    evaluated = service.evaluate(
        EvaluateRequest.model_validate(
            {**{k: v for k, v in raw.items()}, "progress": {"nowMin": now, "routes": [{"vehicleId": vid, "done": done}]}, "routes": routes_of(plan)}
        )
    )
    assert [v for v in evaluated.validation.violations if v.trip_id == "t1"] == []
    first = route(evaluated, vid).stops
    assert (first[0].trip_id, first[0].start_min) == ("t1", done[0]["startMin"])
    assert all(s.start_min >= now for s in first[2:])


def test_an_exclusive_patient_on_board_rides_alone_after_replanning() -> None:
    raw = morning_day()
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    vid = next(r.vehicle_id for r in plan.routes if any(s.trip_id == "t5" for s in r.stops))
    pickup = next(s for s in route(plan, vid).stops if s.trip_id == "t5" and s.kind == "PICKUP")
    done = [{"tripId": "t5", "kind": "PICKUP", "startMin": pickup.start_min, "departureMin": pickup.departure_min}]
    replanned = service.optimize(OptimizeRequest.model_validate(started(raw, plan, pickup.departure_min + 1, {vid: done})))
    stops = route(replanned, vid).stops
    drop = next(k for k, s in enumerate(stops) if s.trip_id == "t5" and s.kind == "DROPOFF")
    assert all(s.load_after <= 1 for s in stops[:drop])
    assert [v for v in replanned.validation.violations if v.code in ("EXCLUSIVE_RIDE", "CAPACITY")] == []


def test_a_trip_is_placed_after_the_stops_done_on_a_started_route(planned: tuple[Json, PlanResponse]) -> None:
    raw, plan = planned
    vid = "taxi_1" if route(plan, "taxi_1").stops else "taxi_2"
    done = done_stops(plan, vid, 2)
    now = done[-1]["departureMin"] + 10
    extra = trip("t7", "p7", "OUTBOUND", offset(MARSEILLE, 1, 1), offset(MARSEILLE, -3, 2), appointment=now + 90)
    day = copy.deepcopy(raw)
    day["trips"].append(extra)
    body = {
        **day,
        "progress": {"nowMin": now, "routes": [{"vehicleId": vid, "done": done}]},
        "routes": routes_of(plan),
        "tripId": "t7",
    }
    answer = service.insert(InsertRequest.model_validate(body))
    option = next((o for o in answer.options if o.vehicle_id == vid), None)
    assert option is not None, answer.rejected
    assert option.pickup_min >= now
    target = next(r for r in option.routes if r.vehicle_id == vid)
    assert [(s.trip_id, s.kind, s.start_min) for s in target.stops[:2]] == [(d["tripId"], d["kind"], d["startMin"]) for d in done]
    # A trip done cannot be placed again.
    with pytest.raises(ValidationError):
        InsertRequest.model_validate({**body, "tripId": done[0]["tripId"]})


def test_the_change_penalty_keeps_the_plan_in_place_for_a_small_gain() -> None:
    marseille_home, aix_home = offset(MARSEILLE, 1, 1), offset(AIX, 1, 1)
    trips = [
        trip("tm", "pm", "OUTBOUND", marseille_home, offset(MARSEILLE, -2, 1), appointment=600),
        trip("ta", "pa", "OUTBOUND", aix_home, offset(AIX, -2, 1), appointment=600),
    ]
    vehicles = [vehicle("taxi_m", MARSEILLE, shift=(420, 1080)), vehicle("taxi_a", AIX, shift=(420, 1080))]
    crossed = [
        {"vehicleId": "taxi_m", "stops": [{"tripId": "ta", "kind": "PICKUP"}, {"tripId": "ta", "kind": "DROPOFF"}]},
        {"vehicleId": "taxi_a", "stops": [{"tripId": "tm", "kind": "PICKUP"}, {"tripId": "tm", "kind": "DROPOFF"}]},
    ]
    raw = {**request(vehicles, trips, timeLimitSec=2), "initialRoutes": crossed}

    def holder(plan: PlanResponse, trip_id: str) -> str:
        return next(r.vehicle_id for r in plan.routes if any(s.trip_id == trip_id for s in r.stops))

    free = service.optimize(OptimizeRequest.model_validate(raw))
    assert (holder(free, "tm"), holder(free, "ta")) == ("taxi_m", "taxi_a")
    sticky = copy.deepcopy(raw)
    sticky["settings"]["changePenalty"] = 500
    kept = service.optimize(OptimizeRequest.model_validate(sticky))
    assert (holder(kept, "tm"), holder(kept, "ta")) == ("taxi_a", "taxi_m")


def test_a_return_whose_patient_waits_past_their_window_is_picked_up_from_now() -> None:
    """« readyMin mis à jour »: at 11:30, a return ready at 10:00 and not picked up yet is planned from now, its
    lateness against the end of the session reported; nothing still to do is planned before now."""
    clinic, home = offset(MARSEILLE, -3, 2), offset(MARSEILLE, 4, 3)
    raw = request([vehicle("taxi_1", MARSEILLE, shift=(420, 1080))], [trip("r1", "p1", "RETURN", clinic, home, ready=600)], timeLimitSec=2)
    plan = service.optimize(OptimizeRequest.model_validate({**raw, "progress": {"nowMin": 690, "routes": []}}))
    assert plan.kpis.trips_served == 1
    pickup = next(s for s in plan.routes[0].stops if s.kind == "PICKUP")
    assert 690 <= pickup.start_min <= 690 + 15 + 30
    assert any(v.code == "TIME_WINDOW" and v.trip_id == "r1" for v in plan.validation.violations)
    # The same day not started: the trip is planned at its own time.
    plain = service.optimize(OptimizeRequest.model_validate(raw))
    assert next(s for s in plain.routes[0].stops if s.kind == "PICKUP").start_min < 690


def test_the_rest_of_a_long_route_takes_its_break_inside_the_route() -> None:
    """The 6-hour rule counts from the route's start: the rest of a route under way since 07:00 takes its break
    before its return, not after it, even when the rest alone lasts less than 6 hours."""
    clinic = offset(MARSEILLE, -3, 2)
    trips = [
        trip("m1", "p1", "OUTBOUND", offset(MARSEILLE, 2, 1), clinic, appointment=480),
        trip("a1", "p2", "OUTBOUND", offset(MARSEILLE, 3, 2), clinic, appointment=800),
        trip("a2", "p3", "OUTBOUND", offset(MARSEILLE, 4, 1), clinic, appointment=880),
    ]
    rule = {"windowStartMin": 690, "windowEndMin": 900, "durationMin": 45}
    raw = request([vehicle("taxi_1", MARSEILLE, shift=(420, 1080), break_=rule)], trips, timeLimitSec=2)
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    first = route(plan, "taxi_1").stops
    done = [{"tripId": s.trip_id, "kind": s.kind, "startMin": s.start_min, "departureMin": s.departure_min} for s in first if s.trip_id == "m1"]
    replanned = service.optimize(OptimizeRequest.model_validate(started(raw, plan, 700, {"taxi_1": done})))
    taxi = route(replanned, "taxi_1")
    assert [v for v in replanned.validation.violations if v.code == "BREAK"] == []
    if taxi.end_min - taxi.start_min > 360:
        assert taxi.break_ is not None and taxi.start_min <= taxi.break_.start_min and taxi.break_.end_min <= taxi.end_min


def afternoon_after_the_break() -> tuple[Json, list[Json]]:
    """A taxi out since 07:00 (two morning trips done), its 12:00–12:45 break taken, three afternoon trips."""
    clinic = offset(MARSEILLE, -3, 2)
    trips = [
        trip("m1", "p1", "OUTBOUND", offset(MARSEILLE, 2, 1), clinic, appointment=480),
        trip("m2", "p2", "OUTBOUND", offset(MARSEILLE, 3, 1), clinic, appointment=600),
        trip("a1", "p3", "OUTBOUND", offset(MARSEILLE, 4, 1), clinic, appointment=840),
        trip("a2", "p4", "OUTBOUND", offset(MARSEILLE, 2, 3), clinic, appointment=900),
        trip("a3", "p5", "OUTBOUND", offset(MARSEILLE, 3, 3), clinic, appointment=960),
    ]
    rule = {"windowStartMin": 690, "windowEndMin": 840, "durationMin": 45}
    raw = request([vehicle("taxi_1", MARSEILLE, shift=(420, 1080), break_=rule)], trips, timeLimitSec=2)
    done = [
        {"tripId": "m1", "kind": "PICKUP", "startMin": 440, "departureMin": 442},
        {"tripId": "m1", "kind": "DROPOFF", "startMin": 460, "departureMin": 462},
        {"tripId": "m2", "kind": "PICKUP", "startMin": 560, "departureMin": 562},
        {"tripId": "m2", "kind": "DROPOFF", "startMin": 580, "departureMin": 582},
    ]
    return raw, done


def test_the_afternoon_of_a_driver_back_from_their_break_is_planned() -> None:
    """A route under way since 07:00 whose driver took their break at noon: at 13:00 its afternoon trips are planned,
    its 6-hour rule met by the break taken (not « sans dépasser 6 h de travail sans pause »)."""
    raw, done = afternoon_after_the_break()
    progress_route: Json = {"vehicleId": "taxi_1", "done": done, "breakTaken": {"startMin": 720, "endMin": 765}}
    body = {**raw, "progress": {"nowMin": 780, "routes": [progress_route]}}
    plan = service.optimize(OptimizeRequest.model_validate(body))
    assert plan.unassigned == [], plan.unassigned
    taxi = route(plan, "taxi_1")
    assert taxi.end_min - taxi.start_min > 360
    assert [v for v in plan.validation.violations if v.code == "BREAK"] == []
    # « Où placer » accepts the vehicle the same afternoon.
    served = {"vehicleId": "taxi_1", "stops": [{"tripId": s.trip_id, "kind": s.kind} for s in taxi.stops if s.trip_id != "a3"]}
    answer = service.insert(InsertRequest.model_validate({**body, "routes": [served], "tripId": "a3"}))
    assert any(o.vehicle_id == "taxi_1" for o in answer.options), answer.rejected


def progress_codes(raw: Json, routes: list[Route]) -> list[tuple[str | None, str | None]]:
    """(trip, vehicle) of each PROGRESS violation the validator finds in these routes of the whole day."""
    parsed = OptimizeRequest.model_validate(raw)
    matrix, _ = build_matrix(request_points(parsed))
    return [(v.trip_id, v.vehicle_id) for v in validate(parsed, routes, matrix) if v.code == "PROGRESS"]


def with_stop(route_: Route, index: int, **times: int) -> Route:
    stops = list(route_.stops)
    stops[index] = stops[index].model_copy(update=times)
    return route_.model_copy(update={"stops": stops})


def test_the_validator_rechecks_the_rules_of_a_day_under_way(planned: tuple[Json, PlanResponse]) -> None:
    """The validator itself (not only the solver) checks that the stops done head their route at their real times,
    are nowhere else, and that nothing still to do starts before the vehicle goes on."""
    raw, plan = planned
    vid = "taxi_1" if route(plan, "taxi_1").stops else "taxi_2"
    done = done_stops(plan, vid, 2, late=3)
    now = done[-1]["departureMin"] + 20
    body = started(raw, plan, now, {vid: done})
    replanned = service.optimize(OptimizeRequest.model_validate(body))
    routes = list(replanned.routes)
    assert progress_codes(body, routes) == []
    mine = next(k for k, r in enumerate(routes) if r.vehicle_id == vid)
    assert len(routes[mine].stops) > 2

    # A stop still to do moved before now.
    early = [*routes]
    early[mine] = with_stop(routes[mine], 2, start_min=now - 30, arrival_min=now - 30)
    assert (routes[mine].stops[2].trip_id, vid) in progress_codes(body, early)
    # A stop done at another time than its real one.
    moved = [*routes]
    moved[mine] = with_stop(routes[mine], 0, start_min=done[0]["startMin"] - 5)
    assert (None, vid) in progress_codes(body, moved)
    # The started route left out of a whole plan.
    assert (None, vid) in progress_codes(body, [r for r in routes if r.vehicle_id != vid])
    # A stop done planned again on another vehicle.
    other = next(k for k, r in enumerate(routes) if r.vehicle_id != vid)
    stolen = [*routes]
    first = routes[mine].stops[0]
    stolen[mine] = routes[mine].model_copy(update={"stops": list(routes[mine].stops[1:])})
    stolen[other] = routes[other].model_copy(update={"stops": [*routes[other].stops, first]})
    assert (first.trip_id, routes[other].vehicle_id) in progress_codes(body, stolen)


def test_the_dropoff_of_a_patient_on_board_may_come_before_now_never_before_their_pickup(planned: tuple[Json, PlanResponse]) -> None:
    """README « Journée commencée », point 2: a vehicle with a patient on board drove on with them since its last stop
    done; their dropoff may be planned before now, not before the end of that stop."""
    raw, plan = planned
    vid = "taxi_1" if route(plan, "taxi_1").stops else "taxi_2"
    stops = route(plan, vid).stops
    first_pickup = next(k for k, s in enumerate(stops) if s.kind == "PICKUP")
    done = done_stops(plan, vid, first_pickup + 1)
    on_board = done[-1]["tripId"]
    now = done[-1]["departureMin"] + 60
    body = started(raw, plan, now, {vid: done})
    replanned = service.optimize(OptimizeRequest.model_validate(body))
    routes = list(replanned.routes)
    mine = next(k for k, r in enumerate(routes) if r.vehicle_id == vid)
    drop = next(k for k, s in enumerate(routes[mine].stops) if s.trip_id == on_board and s.kind == "DROPOFF")
    assert progress_codes(body, routes) == []
    before_now = [*routes]
    before_now[mine] = with_stop(routes[mine], drop, start_min=now - 10, arrival_min=now - 10)
    assert progress_codes(body, before_now) == []
    before_pickup = [*routes]
    before_pickup[mine] = with_stop(routes[mine], drop, start_min=done[-1]["departureMin"] - 1, arrival_min=done[-1]["departureMin"] - 1)
    assert (on_board, vid) in progress_codes(body, before_pickup)


def test_a_return_continuation_waits_by_the_vehicle_not_at_the_facility() -> None:
    """A patient picked up again where their transport was interrupted (contract « Course de reprise »): at 11:00 the
    only vehicle is 40 minutes away, beyond the 15 minutes after the session a return allows, and the continuation is
    served all the same, with no wait at the facility reported; a plain return there is not."""
    clinic, home, roadside = offset(MARSEILLE, -3, 2), offset(MARSEILLE, 4, 3), offset(AIX, 8, 6)
    outbound = trip("o1", "p1", "OUTBOUND", home, clinic, appointment=480)
    resumed = {**trip("c1", "p1", "RETURN", roadside, home, ready=660), "continuation": True}
    taxi = vehicle("taxi_1", MARSEILLE, shift=(420, 1080))
    under_way = {"progress": {"nowMin": 660, "routes": []}}

    def plan_of(trips: list[Json]) -> PlanResponse:
        return service.optimize(OptimizeRequest.model_validate({**request([taxi], trips, timeLimitSec=2), **under_way}))

    plan = plan_of([resumed])
    assert plan.kpis.trips_served == 1, plan.unassigned
    pickup = next(s for s in plan.routes[0].stops if s.kind == "PICKUP")
    assert pickup.start_min > 660 + 15
    assert plan.validation.violations == []
    assert next(t for t in plan.trips if t.trip_id == "c1").wait_at_facility_min is None
    # Not paired with the patient's outbound (done in the morning): no wait at the facility added up.
    with_outbound = plan_of([outbound, resumed])
    assert [v for v in with_outbound.validation.violations if v.code == "TOTAL_WAIT"] == []
    assert plan_of([{**resumed, "continuation": False}]).kpis.trips_served == 0
