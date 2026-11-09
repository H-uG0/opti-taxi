"""Revenue of planned routes (plan.py with pricing.py) and its independent check (validator, REVENUE):
the route decides the billed distance, the sharing discount, the empty leg and the surcharge times."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app import service
from app.context import request_points
from app.matrix import build_matrix
from app.schemas import PlanResponse, TripResult
from app.validator import validate_revenue
from tests.builders import AIX, MARSEILLE, evaluate_request, offset, request, trip, vehicle

FARE_CASES = json.loads((Path(__file__).resolve().parents[3] / "contract" / "fixtures" / "fare-cases.json").read_text("utf-8"))
GRIDS = {grid["id"]: grid for grid in FARE_CASES["grids"]}

HOME = offset(MARSEILLE, 2, 1)
NEIGHBOUR = offset(HOME, 0.4, 0.3)
CLINIC = offset(AIX, 0.5, -0.5)


def day(vehicles: list[dict[str, Any]], trips: list[dict[str, Any]], **pricing: Any) -> dict[str, Any]:
    raw = request(vehicles, trips)
    raw["tariffs"] = list(GRIDS.values())
    raw["settings"]["pricing"] = {"emptyLeg": "DEPOT", **pricing}
    return raw


def evaluate(raw: dict[str, Any], routes: dict[str, list[tuple[str, str]]]) -> PlanResponse:
    return service.evaluate(evaluate_request(raw, routes))


def results(plan: PlanResponse) -> dict[str, TripResult]:
    return {t.trip_id: t for t in plan.trips}


def solo_fare(km: float, per_km: float = 1.10, included: float = 4, fare: float = 13, factor: float = 1.0) -> float:
    return (fare + max(0.0, km - included) * per_km) * factor


def test_empty_leg_on_the_last_dropoff_of_the_route_only() -> None:
    taxi = vehicle("taxi", MARSEILLE, tariff_id="taxi_13")
    first = {**trip("first", "p1", "OUTBOUND", HOME, CLINIC, appointment=600), "hospitalLinked": True}
    second = {**trip("second", "p2", "OUTBOUND", NEIGHBOUR, CLINIC, appointment=720), "hospitalLinked": True}
    plan = evaluate(day([taxi], [first, second]), {"taxi": [("first", "PICKUP"), ("first", "DROPOFF"), ("second", "PICKUP"), ("second", "DROPOFF")]})
    assert plan.validation.valid, plan.validation.violations
    got = results(plan)
    assert got["first"].revenue == pytest.approx(solo_fare(got["first"].direct_km), abs=0.011)
    # The vehicle drives back empty to its station after the last dropoff: km rate +25 % (< 50 km).
    km = got["second"].direct_km
    assert got["second"].revenue == pytest.approx(13 + (km - 4) * 1.10 * 1.25, abs=0.011)


def test_no_empty_leg_when_the_rule_is_off_or_the_trip_is_not_hospital_linked() -> None:
    taxi = vehicle("taxi", MARSEILLE, tariff_id="taxi_13")
    linked = {**trip("t", "p", "OUTBOUND", HOME, CLINIC, appointment=600), "hospitalLinked": True}
    route = {"taxi": [("t", "PICKUP"), ("t", "DROPOFF")]}
    off = results(evaluate(day([taxi], [linked], emptyLeg="NONE"), route))["t"]
    assert off.revenue == pytest.approx(solo_fare(off.direct_km), abs=0.011)
    plain = results(evaluate(day([taxi], [{**linked, "hospitalLinked": False}]), route))["t"]
    assert plain.revenue == off.revenue


def test_return_from_hospital_first_in_the_route_has_the_empty_leg() -> None:
    taxi = vehicle("taxi", MARSEILLE, tariff_id="taxi_13")
    back = {**trip("back", "p", "RETURN", CLINIC, HOME, ready=900), "hospitalLinked": True}
    got = results(evaluate(day([taxi], [back]), {"taxi": [("back", "PICKUP"), ("back", "DROPOFF")]}))["back"]
    assert got.revenue == pytest.approx(13 + (got.direct_km - 4) * 1.10 * 1.25, abs=0.011)


def test_seated_trip_in_an_ambulance_is_billed_at_the_vsl_tariff() -> None:
    ambulance = vehicle("amb", MARSEILLE, type_="AMBULANCE", tariff_id="ambulance_certified")
    seated = {
        **trip("t", "p", "OUTBOUND", HOME, CLINIC, appointment=600, types=("TAXI", "VSL", "AMBULANCE"), locked="amb"),
        "tariffId": "vsl_certified",
    }
    plan = evaluate(day([ambulance], [seated]), {"amb": [("t", "PICKUP"), ("t", "DROPOFF")]})
    assert plan.validation.valid, plan.validation.violations
    got = results(plan)["t"]
    assert got.revenue == pytest.approx(solo_fare(got.direct_km, per_km=1.10, included=3, fare=15.75), abs=0.011)
    assert plan.routes[0].revenue == got.revenue


def test_shared_vsl_bills_the_detour_within_the_cap_and_the_discount() -> None:
    vsl = vehicle("vsl", MARSEILLE, type_="VSL", tariff_id="vsl_certified")
    a = trip("a", "pa", "OUTBOUND", HOME, CLINIC, appointment=600)
    b = trip("b", "pb", "OUTBOUND", NEIGHBOUR, CLINIC, appointment=600)
    plan = evaluate(day([vsl], [a, b]), {"vsl": [("a", "PICKUP"), ("b", "PICKUP"), ("a", "DROPOFF"), ("b", "DROPOFF")]})
    assert plan.validation.valid, plan.validation.violations
    got = results(plan)
    assert got["a"].shared and got["a"].detour_km > 0
    billed = got["a"].direct_km + min(got["a"].detour_km, 10)
    assert got["a"].revenue == pytest.approx(solo_fare(billed, per_km=1.10, included=3, fare=15.75) * 0.85, abs=0.011)


def test_public_holiday_of_the_settings_raises_the_fare() -> None:
    taxi = vehicle("taxi", MARSEILLE, tariff_id="taxi_13")
    one = trip("t", "p", "OUTBOUND", HOME, CLINIC, appointment=600)
    route = {"taxi": [("t", "PICKUP"), ("t", "DROPOFF")]}
    raw = day([taxi], [one])
    weekday = results(evaluate(raw, route))["t"].revenue
    raw["settings"]["pricing"]["publicHolidays"] = [raw["date"]]
    holiday = results(evaluate(raw, route))["t"].revenue
    assert holiday == pytest.approx(weekday * 1.5, abs=0.011)


def test_patient_count_rule_changes_the_discount() -> None:
    taxi = vehicle("taxi", MARSEILLE, tariff_id="taxi_13", capacity=2)
    a = trip("a", "pa", "OUTBOUND", HOME, CLINIC, appointment=630)
    b = trip("b", "pb", "OUTBOUND", NEIGHBOUR, offset(HOME, 3, 3), appointment=600)
    c = trip("c", "pc", "OUTBOUND", offset(HOME, 3, 3), CLINIC, appointment=630)
    # a rides with b, then with c: three distinct patients, never more than two on board.
    route = {"taxi": [("a", "PICKUP"), ("b", "PICKUP"), ("b", "DROPOFF"), ("c", "PICKUP"), ("a", "DROPOFF"), ("c", "DROPOFF")]}
    distinct = results(evaluate(day([taxi], [a, b, c]), route))["a"]
    most = results(evaluate(day([taxi], [a, b, c], patientCount="MAX_ON_BOARD"), route))["a"]
    assert distinct.co_passenger_trip_ids == ["b", "c"]
    assert distinct.revenue < most.revenue


def test_tampered_revenue_is_reported() -> None:
    taxi = vehicle("taxi", MARSEILLE, tariff_id="taxi_13")
    raw = day([taxi], [trip("t", "p", "OUTBOUND", HOME, CLINIC, appointment=600)])
    evaluation = evaluate_request(raw, {"taxi": [("t", "PICKUP"), ("t", "DROPOFF")]})
    matrix, _ = build_matrix(request_points(evaluation), None)
    plan = service.evaluate(evaluation)
    assert validate_revenue(evaluation, plan.routes, plan.trips, matrix) == []
    tampered = [t.model_copy(update={"revenue": t.revenue + 0.05}) for t in plan.trips]
    found = validate_revenue(evaluation, plan.routes, tampered, matrix)
    assert [(v.code, v.trip_id) for v in found] == [("REVENUE", "t")]
    route = plan.routes[0].model_copy(update={"revenue": plan.routes[0].revenue + 1})
    assert [v.code for v in validate_revenue(evaluation, [route], plan.trips, matrix)] == ["REVENUE"]
    # One cent apart is within the tolerance.
    close = [t.model_copy(update={"revenue": round(t.revenue + 0.01, 2)}) for t in plan.trips]
    assert validate_revenue(evaluation, plan.routes, close, matrix) == []
