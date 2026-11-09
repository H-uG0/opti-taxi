"""Independent validator: a clean plan passes, and every violation code is detected."""

from __future__ import annotations

import time
from typing import Any

from app.context import make_context, request_points
from app.matrix import TravelMatrix, build_matrix
from app.plan import PlanOutcome, build_response
from app.schemas import BreakSlot, OptimizeRequest, Route, RoutePlan, StopRef, Violation
from app.validator import check_plan_references, validate
from tests.builders import AIX, GAP, MARSEILLE, offset, request, trip, vehicle

HOME_A = offset(MARSEILLE, 3, 2)
HOME_B = offset(HOME_A, 0.5, 0.5)
HOME_FAR = offset(HOME_A, -9, 12)
AIX_FAC = (43.5260, 5.4380)
MRS_FAC = (43.2897, 5.4026)
TAXI_BREAK = {"windowStartMin": 690, "windowEndMin": 840, "durationMin": 45}

Sequences = dict[str, list[tuple[str, str]]]

CLEAN: Sequences = {
    "taxi_1": [
        ("a_out", "PICKUP"), ("b_out", "PICKUP"), ("a_out", "DROPOFF"), ("b_out", "DROPOFF"),
        ("a_ret", "PICKUP"), ("a_ret", "DROPOFF"),
    ],
    "amb_1": [("c_amb", "PICKUP"), ("c_amb", "DROPOFF")],
}


def scenario(extra_trips: list[dict[str, Any]] | None = None, **settings: Any) -> dict[str, Any]:
    vehicles = [
        vehicle("taxi_1", MARSEILLE, break_=TAXI_BREAK),
        vehicle("taxi_2", AIX),
        vehicle("amb_1", MARSEILLE, type_="AMBULANCE"),
    ]
    trips = [
        trip("a_out", "pat_a", "OUTBOUND", HOME_A, AIX_FAC, appointment=480),
        trip("b_out", "pat_b", "OUTBOUND", HOME_B, AIX_FAC, appointment=480),
        trip("a_ret", "pat_a", "RETURN", AIX_FAC, HOME_A, ready=660),
        trip("c_amb", "pat_c", "OUTBOUND", offset(MARSEILLE, -2, 3), MRS_FAC, appointment=540,
             types=("AMBULANCE",), shareable=False),
        *(extra_trips or []),
    ]
    return request(vehicles, trips, **settings)


def planned(raw: dict[str, Any], sequences: Sequences) -> tuple[OptimizeRequest, list[Route], TravelMatrix]:
    """Routes with times for hand-written stop sequences."""
    parsed = OptimizeRequest.model_validate(raw)
    matrix, _ = build_matrix(request_points(parsed))
    ctx = make_context(parsed, matrix)
    refs = {v: [StopRef(trip_id=t, kind=k) for t, k in stops] for v, stops in sequences.items()}  # type: ignore[arg-type]
    response = build_response(ctx, PlanOutcome(refs, {}, "Non planifiée", "OK", "TEST", None), time.perf_counter())
    return parsed, list(response.routes), matrix


def codes(violations: list[Violation]) -> set[str]:
    return {v.code for v in violations}


def route_of(routes: list[Route], vehicle_id: str) -> Route:
    return next(r for r in routes if r.vehicle_id == vehicle_id)


def replace_route(routes: list[Route], new: Route) -> list[Route]:
    return [new if r.vehicle_id == new.vehicle_id else r for r in routes]


def test_clean_plan_is_valid() -> None:
    req, routes, matrix = planned(scenario(), CLEAN)
    assert validate(req, routes, matrix) == []
    taxi = route_of(routes, "taxi_1")
    assert taxi.break_ is not None and taxi.break_.end_min - taxi.break_.start_min == 45


def test_unknown_vehicle_and_trip() -> None:
    req, routes, matrix = planned(scenario(), CLEAN)
    amb = route_of(routes, "amb_1")
    ghost_stop = amb.stops[0].model_copy(update={"trip_id": "nope"})
    routes = replace_route(routes, amb.model_copy(update={"stops": [*amb.stops, ghost_stop]}))
    routes.append(amb.model_copy(update={"vehicle_id": "ghost", "stops": []}))
    found = validate(req, routes, matrix)
    unknown = [v for v in found if v.code == "UNKNOWN_REFERENCE"]
    assert {v.trip_id for v in unknown} == {"nope", None}
    assert {v.vehicle_id for v in unknown} == {"amb_1", "ghost"}


def test_duplicate_trip() -> None:
    req, routes, matrix = planned(scenario(), CLEAN)
    taxi, amb = route_of(routes, "taxi_1"), route_of(routes, "amb_1")
    routes = replace_route(routes, taxi.model_copy(update={"stops": [*taxi.stops, amb.stops[0]]}))
    found = validate(req, routes, matrix)
    assert any(v.code == "DUPLICATE_TRIP" and v.trip_id == "c_amb" for v in found)


def test_pairing_missing_dropoff_and_wrong_order() -> None:
    req, routes, matrix = planned(scenario(), CLEAN)
    taxi = route_of(routes, "taxi_1")
    truncated = replace_route(routes, taxi.model_copy(update={"stops": taxi.stops[:-1]}))
    assert any(v.code == "PAIRING" and v.trip_id == "a_ret" for v in validate(req, truncated, matrix))

    req, routes, matrix = planned(scenario(), {"amb_1": [("c_amb", "DROPOFF"), ("c_amb", "PICKUP")]})
    assert any(v.code == "PAIRING" and "avant" in v.message for v in validate(req, routes, matrix))


def test_lock_on_another_vehicle() -> None:
    raw = scenario()
    raw["trips"][2]["lockedVehicleId"] = "taxi_2"
    req, routes, matrix = planned(raw, CLEAN)
    found = validate(req, routes, matrix)
    assert [v for v in found if v.code == "LOCK"][0].trip_id == "a_ret"


def test_vehicle_type_not_allowed() -> None:
    req, routes, matrix = planned(scenario(), {"taxi_1": [("c_amb", "PICKUP"), ("c_amb", "DROPOFF")]})
    found = validate(req, routes, matrix)
    assert codes(found) == {"VEHICLE_TYPE"}


def test_capacity_exceeded() -> None:
    raw = scenario([trip("d_out", "pat_d", "OUTBOUND", offset(HOME_A, -0.5, 0.3), AIX_FAC, appointment=480)])
    sequences: Sequences = {
        "taxi_1": [
            ("a_out", "PICKUP"), ("b_out", "PICKUP"), ("d_out", "PICKUP"),
            ("a_out", "DROPOFF"), ("b_out", "DROPOFF"), ("d_out", "DROPOFF"),
        ]
    }
    req, routes, matrix = planned(raw, sequences)
    assert "CAPACITY" in codes(validate(req, routes, matrix))


def test_exclusive_ride() -> None:
    raw = scenario()
    raw["trips"][1]["shareable"] = False
    req, routes, matrix = planned(raw, CLEAN)
    found = validate(req, routes, matrix)
    assert [v.trip_id for v in found if v.code == "EXCLUSIVE_RIDE"] == ["b_out"]


def test_late_arrival_at_appointment() -> None:
    req, routes, matrix = planned(scenario(), CLEAN)
    taxi = route_of(routes, "taxi_1")
    stops = list(taxi.stops)
    stops[2] = stops[2].model_copy(update={"arrival_min": 490, "start_min": 490, "departure_min": 495})
    found = validate(req, replace_route(routes, taxi.model_copy(update={"stops": stops})), matrix)
    late = [v for v in found if v.code == "TIME_WINDOW" and v.trip_id == "a_out"]
    assert late and "après le rendez-vous" in late[0].message


def test_return_pickup_too_late_after_session() -> None:
    req, routes, matrix = planned(scenario(), CLEAN)
    taxi = route_of(routes, "taxi_1")
    stops = list(taxi.stops)
    stops[4] = stops[4].model_copy(update={"arrival_min": 640, "start_min": 680, "departure_min": 685})
    found = validate(req, replace_route(routes, taxi.model_copy(update={"stops": stops})), matrix)
    assert any(v.code == "TIME_WINDOW" and v.trip_id == "a_ret" and "après la fin de séance" in v.message for v in found)


def test_total_wait() -> None:
    _, routes, matrix = planned(scenario(), CLEAN)
    strict = OptimizeRequest.model_validate(scenario(maxTotalWaitMin=20))
    a_dropoff = route_of(routes, "taxi_1").stops[2]
    assert a_dropoff.start_min <= 460  # 20+ min before the 08:00 appointment
    found = {v.trip_id: v.message for v in validate(strict, routes, matrix) if v.code == "TOTAL_WAIT"}
    assert "aller" in found["a_ret"] and "retour" in found["a_ret"]  # the pair of patient A
    # Patient B has no return that day: their outbound alone is checked against the total.
    assert "avant le rendez-vous" in found["b_out"]


def dialysis_returns(**settings: Any) -> tuple[OptimizeRequest, list[Route], TravelMatrix]:
    """Patients A and B leave the same dialysis center in one taxi: A is ready at 11:00, B at 11:30.
    A, picked up at the end of their window (11:15), waits in the parked taxi until B's pickup."""
    trips = [
        trip("a_out", "pat_a", "OUTBOUND", HOME_A, AIX_FAC, appointment=480),
        trip("a_ret", "pat_a", "RETURN", AIX_FAC, HOME_A, ready=660),
        trip("b_ret", "pat_b", "RETURN", AIX_FAC, HOME_B, ready=690),
    ]
    raw = request([vehicle("taxi_1", MARSEILLE), vehicle("taxi_2", AIX)], trips, **settings)
    sequences: Sequences = {
        "taxi_1": [("a_out", "PICKUP"), ("a_out", "DROPOFF")],
        "taxi_2": [("a_ret", "PICKUP"), ("b_ret", "PICKUP"), ("a_ret", "DROPOFF"), ("b_ret", "DROPOFF")],
    }
    return planned(raw, sequences)


def test_wait_on_board_at_the_facility_counts_in_the_total_wait() -> None:
    req, routes, matrix = dialysis_returns()
    taxi = route_of(routes, "taxi_2")
    a_pickup, b_pickup = taxi.stops[0], taxi.stops[1]
    assert (a_pickup.start_min, b_pickup.arrival_min, b_pickup.start_min) == (675, 680, 690)
    assert route_of(routes, "taxi_1").stops[1].start_min == 450  # 30 min before the appointment
    found = [v for v in validate(req, routes, matrix) if v.code == "TOTAL_WAIT"]
    # 30 min before + 15 min after the session + 10 min in the parked taxi: 55 min, not 45.
    assert [v.trip_id for v in found] == ["a_ret"]
    assert "55 min" in found[0].message and "dont 10 min à bord" in found[0].message


def test_ride_time() -> None:
    req, routes, matrix = dialysis_returns(maxRideExtraMin=5)
    rides = {v.trip_id: v.message for v in validate(req, routes, matrix) if v.code == "RIDE_TIME"}
    # A rides through B's pickup (5 min) and the 10 min wait, B through A's dropoff: over direct + 5.
    assert set(rides) == {"a_ret", "b_ret"}
    assert "trajet direct + 5 min" in rides["a_ret"]
    req, routes, matrix = dialysis_returns()
    assert not [v for v in validate(req, routes, matrix) if v.code == "RIDE_TIME"]


def test_route_longer_than_six_hours_needs_a_break() -> None:
    trips = [
        trip("early", "p1", "OUTBOUND", HOME_A, AIX_FAC, appointment=480),
        trip("late", "p2", "RETURN", AIX_FAC, HOME_A, ready=900),
    ]
    sequences: Sequences = {"taxi_1": [("early", "PICKUP"), ("early", "DROPOFF"), ("late", "PICKUP"), ("late", "DROPOFF")]}
    req, routes, matrix = planned(request([vehicle("taxi_1", MARSEILLE)], trips), sequences)
    taxi = route_of(routes, "taxi_1")
    assert taxi.end_min - taxi.start_min > 360 and taxi.break_ is None
    work = [v for v in validate(req, routes, matrix) if v.code == "BREAK"]
    assert len(work) == 1 and "L3121-16" in work[0].message
    # With a 45 min break inside the route, the same day is lawful.
    raw = request([vehicle("taxi_1", MARSEILLE, break_=TAXI_BREAK)], trips)
    req, routes, matrix = planned(raw, sequences)
    assert validate(req, routes, matrix) == []


def test_detour() -> None:
    raw = scenario([trip("e_out", "pat_e", "OUTBOUND", HOME_FAR, AIX_FAC, appointment=480)])
    sequences: Sequences = {
        "taxi_1": [("a_out", "PICKUP"), ("e_out", "PICKUP"), ("a_out", "DROPOFF"), ("e_out", "DROPOFF")]
    }
    req, routes, matrix = planned(raw, sequences)
    detours = [v for v in validate(req, routes, matrix) if v.code == "DETOUR"]
    assert [v.trip_id for v in detours] == ["a_out"]


def test_shift() -> None:
    req, routes, matrix = planned(scenario(), CLEAN)
    taxi = route_of(routes, "taxi_1")
    early = replace_route(routes, taxi.model_copy(update={"start_min": 300}))
    assert any(v.code == "SHIFT" and "avant le début de service" in v.message for v in validate(req, early, matrix))
    late = replace_route(routes, taxi.model_copy(update={"end_min": 1200}))
    assert any(v.code == "SHIFT" and "après la fin de service" in v.message for v in validate(req, late, matrix))


def test_break_missing_when_a_patient_rides_through_the_window() -> None:
    raw = scenario([trip("long", "pat_l", "RETURN", GAP, HOME_A, ready=690)])
    raw["vehicles"][0]["break"] = {"windowStartMin": 690, "windowEndMin": 760, "durationMin": 45}
    req, routes, matrix = planned(raw, {"taxi_1": [("long", "PICKUP"), ("long", "DROPOFF")]})
    assert route_of(routes, "taxi_1").break_ is None
    assert codes(validate(req, routes, matrix)) == {"BREAK"}


def test_break_overlapping_a_stop() -> None:
    req, routes, matrix = planned(scenario(), CLEAN)
    taxi = route_of(routes, "taxi_1")
    pickup = taxi.stops[4]
    slot = BreakSlot(start_min=max(690, pickup.start_min - 10), end_min=max(690, pickup.start_min - 10) + 45)
    found = validate(req, replace_route(routes, taxi.model_copy(update={"break_": slot})), matrix)
    assert "BREAK" in codes(found)


def test_plan_references_are_cleaned() -> None:
    req = OptimizeRequest.model_validate(scenario())
    plans = [
        RoutePlan(vehicle_id="ghost", stops=[StopRef(trip_id="a_out", kind="PICKUP")]),
        RoutePlan(
            vehicle_id="taxi_1",
            stops=[
                StopRef(trip_id="a_out", kind="PICKUP"),
                StopRef(trip_id="zzz", kind="PICKUP"),
                StopRef(trip_id="a_out", kind="DROPOFF"),
                StopRef(trip_id="a_out", kind="DROPOFF"),
            ],
        ),
    ]
    sequences, violations, warnings = check_plan_references(req, plans)
    assert [(s.trip_id, s.kind) for s in sequences["taxi_1"]] == [("a_out", "PICKUP"), ("a_out", "DROPOFF")]
    assert [v.code for v in violations] == ["UNKNOWN_REFERENCE", "UNKNOWN_REFERENCE", "DUPLICATE_TRIP"]
    assert warnings == []
