"""POST /insert (app/insertion.py): the best place of one trip in each vehicle's route in place, the
other routes kept; every option is what /evaluate reports for the plan it makes, breaks no new rule,
and a vehicle without a place says why."""

from __future__ import annotations

import copy
import gzip
import json
import time
from pathlib import Path
from typing import Any

import pytest

from app import service
from app.schemas import EvaluateRequest, InsertOption, InsertRequest, InsertResponse, PlanResponse
from tests.builders import MARSEILLE, load_fixture, offset, request, trip, vehicle

SEED_FLEET_DAY = Path(__file__).resolve().parent / "data" / "seed-fleet-2026-11-11.json.gz"
"""11/11 of the large seed (290 trips, 118 vehicles) with its plan in place (tests/test_repair.py)."""
FLEET_BUDGET_SEC = 2.0
"""The assistant answers within 2 s on the large seed (backlog INS-01); about 0.5 s measured."""


def insert(raw: dict[str, Any], trip_id: str, **extra: Any) -> InsertResponse:
    return service.insert(InsertRequest.model_validate({**raw, "tripId": trip_id, **extra}))


def applied(raw: dict[str, Any], response: InsertResponse, option: InsertOption) -> list[dict[str, Any]]:
    """The routes in place with the option's routes instead of those of its vehicles (and of the
    source, left out when the option has no route for it any more)."""
    changed = {route.vehicle_id: route for route in option.routes}
    gone = {response.from_vehicle_id} - set(changed)
    routes = [route for route in raw["routes"] if route["vehicleId"] not in changed and route["vehicleId"] not in gone]
    routes += [{"vehicleId": r.vehicle_id, "stops": [{"tripId": s.trip_id, "kind": s.kind} for s in r.stops]} for r in option.routes]
    return routes


def evaluated(raw: dict[str, Any], routes: list[dict[str, Any]], unlocked: str | None = None) -> PlanResponse:
    day = copy.deepcopy({key: value for key, value in raw.items() if key not in ("routes", "tripId", "vehicleIds")})
    if unlocked is not None:
        for t in day["trips"]:
            if t["id"] == unlocked:
                t["lockedVehicleId"] = None
    return service.evaluate(EvaluateRequest.model_validate({**day, "routes": routes}))


def assert_option_is_the_evaluated_plan(raw: dict[str, Any], response: InsertResponse, option: InsertOption) -> PlanResponse:
    """The option's routes and trip results are those /evaluate reports for the plan it makes, and
    its figures are the difference of that plan's KPIs with the plan in place."""
    before = evaluated(raw, raw["routes"], unlocked=response.trip_id)
    after = evaluated(raw, applied(raw, response, option), unlocked=response.trip_id)
    by_vehicle = {route.vehicle_id: route for route in after.routes}
    for route in option.routes:
        assert route.model_dump() == by_vehicle[route.vehicle_id].model_dump(), route.vehicle_id
    results = {result.trip_id: result for result in after.trips}
    for result in option.trips:
        assert result.model_dump() == results[result.trip_id].model_dump(), result.trip_id
    assert option.delta_km == pytest.approx(after.kpis.total_km - before.kpis.total_km, abs=0.011)
    assert option.delta_empty_km == pytest.approx(after.kpis.empty_km - before.kpis.empty_km, abs=0.011)
    assert option.delta_margin == pytest.approx(after.kpis.margin - before.kpis.margin, abs=0.021)
    assert option.delta_revenue == pytest.approx(after.kpis.revenue - before.kpis.revenue, abs=0.011)
    known = {(v.code, v.trip_id, v.vehicle_id) for v in before.validation.violations}
    assert [v for v in after.validation.violations if (v.code, v.trip_id, v.vehicle_id) not in known] == []
    return after


# --------------------------------------------------------------------------- contract fixture


@pytest.fixture(scope="module")
def fixture_answer() -> InsertResponse:
    return service.insert(InsertRequest.model_validate(load_fixture("insert-request.json")))


def test_a_trip_without_vehicle_gets_its_best_place(fixture_answer: InsertResponse) -> None:
    answer = fixture_answer
    assert answer.trip_id == "trip_1" and answer.from_vehicle_id is None
    assert answer.meta.solver_status == "INSERT" and answer.meta.objective is None
    [option] = answer.options
    assert option.vehicle_id == "veh_taxi_1"
    # Back beside trip_3, as /optimize had put it: shared, a few km more, the margin of a whole invoice more.
    assert option.shared and option.co_passenger_trip_ids == ["trip_3"]
    assert option.delta_margin > 0 and option.delta_revenue > option.delta_cost
    assert option.violations == []
    assert {route.vehicle_id for route in option.routes} == {"veh_taxi_1"}
    assert [(s.trip_id, s.dropoff_shift_min) for s in option.shifts] == [("trip_3", 5)]
    # The VSL leaves too late to be in Marseille for 07:30: said with its hours.
    assert [(r.vehicle_id, r.kind) for r in answer.rejected] == [("veh_vsl_1", "SHIFT")]
    assert "06:30–18:30" in answer.rejected[0].reason
    assert_option_is_the_evaluated_plan(load_fixture("insert-request.json"), answer, option)


def test_fixture_answer_matches_the_contract_example(fixture_answer: InsertResponse) -> None:
    expected = InsertResponse.model_validate(load_fixture("insert-response.json"))
    got = fixture_answer.model_dump()
    want = expected.model_dump()
    got["meta"]["wall_time_ms"] = want["meta"]["wall_time_ms"]
    assert got == want


def test_a_move_takes_the_trip_out_of_its_route_and_lifts_its_lock() -> None:
    raw = load_fixture("evaluate-request.json")
    answer = insert(raw, "trip_7")  # locked on the VSL, its only trip
    assert answer.from_vehicle_id == "veh_vsl_1"
    [option] = answer.options
    assert option.vehicle_id == "veh_taxi_1" and answer.rejected == []
    # The VSL is left without a stop: no route for it in the option, the plan loses its km.
    assert {route.vehicle_id for route in option.routes} == {"veh_taxi_1"}
    assert option.delta_km < 0
    after = assert_option_is_the_evaluated_plan(raw, answer, option)
    assert {route.vehicle_id for route in after.routes} == {"veh_taxi_1", "veh_amb_1"}


def test_a_move_reports_both_routes_and_the_patients_it_delays() -> None:
    raw = load_fixture("evaluate-request.json")
    answer = insert(raw, "trip_2")
    assert answer.from_vehicle_id == "veh_taxi_1"
    [option] = answer.options
    assert option.vehicle_id == "veh_vsl_1"
    assert {route.vehicle_id for route in option.routes} == {"veh_taxi_1", "veh_vsl_1"}
    # trip_4 rode with trip_2: without it, it is dropped sooner.
    shifted = {s.trip_id: s for s in option.shifts}
    assert shifted["trip_4"].dropoff_shift_min < 0
    assert {result.trip_id for result in option.trips} == {"trip_1", "trip_2", "trip_3", "trip_4", "trip_7"}
    assert_option_is_the_evaluated_plan(raw, answer, option)


def test_vehicle_ids_restrict_the_vehicles_tried() -> None:
    raw = load_fixture("insert-request.json")
    answer = insert(raw, "trip_1", vehicleIds=["veh_vsl_1"])
    assert answer.options == []
    assert [r.vehicle_id for r in answer.rejected] == ["veh_vsl_1"]
    answer = insert(raw, "trip_1", vehicleIds=["veh_taxi_1"])
    assert [o.vehicle_id for o in answer.options] == ["veh_taxi_1"] and answer.rejected == []


def test_a_vehicle_of_another_type_is_not_listed() -> None:
    raw = load_fixture("insert-request.json")
    answer = insert(raw, "trip_5")  # ambulance only: the one ambulance is its own vehicle
    assert answer.from_vehicle_id == "veh_amb_1"
    assert answer.options == [] and answer.rejected == []


def test_a_route_already_breaking_a_rule_gets_nothing() -> None:
    raw = load_fixture("insert-request.json")
    for v in raw["vehicles"]:
        if v["id"] == "veh_taxi_1":
            v["shiftEndMin"] = 700  # its returns of 11:30 end after the shift
    answer = insert(raw, "trip_1")
    assert answer.options == []
    taxi = next(r for r in answer.rejected if r.vehicle_id == "veh_taxi_1")
    assert taxi.kind == "RULES" and "réoptimisez" in taxi.reason


def test_an_unknown_trip_is_refused() -> None:
    with pytest.raises(ValueError, match="tripId"):
        InsertRequest.model_validate({**load_fixture("insert-request.json"), "tripId": "trip_404"})


# --------------------------------------------------------------------------- reasons


def busy_day() -> dict[str, Any]:
    """A 12:00 appointment in Marseille and four taxis: one free, one carrying a patient who travels
    alone, one whose driver rests from 11:20 to 12:20, one working the afternoon."""
    home, facility = offset(MARSEILLE, 3, 2), offset(MARSEILLE, -2, 1)
    tight_break = {"windowStartMin": 680, "windowEndMin": 740, "durationMin": 60}
    vehicles = [
        vehicle("taxi_free", MARSEILLE),
        vehicle("taxi_busy", MARSEILLE),
        vehicle("taxi_rest", MARSEILLE, break_=tight_break),
        vehicle("taxi_late", MARSEILLE, shift=(780, 1140)),
        vehicle("amb_1", MARSEILLE, type_="AMBULANCE"),
    ]
    trips = [
        trip("t_new", "p_new", "OUTBOUND", home, facility, appointment=720),
        trip("t_alone", "p_alone", "OUTBOUND", offset(home, 1, 0), facility, appointment=715, shareable=False),
    ]
    raw = request(vehicles, trips)
    raw["routes"] = [{"vehicleId": "taxi_busy", "stops": [{"tripId": "t_alone", "kind": "PICKUP"}, {"tripId": "t_alone", "kind": "DROPOFF"}]}]
    return raw


def test_each_vehicle_without_a_place_says_why() -> None:
    raw = busy_day()
    answer = insert(raw, "t_new")
    assert [o.vehicle_id for o in answer.options] == ["taxi_free"]
    reasons = {r.vehicle_id: r for r in answer.rejected}
    assert set(reasons) == {"taxi_busy", "taxi_rest", "taxi_late"}  # no ambulance: not prescribed
    assert reasons["taxi_busy"].kind == "OCCUPIED" and reasons["taxi_busy"].reason.startswith("transporte un autre patient")
    assert reasons["taxi_rest"].kind == "BREAK"
    assert reasons["taxi_late"].kind == "SHIFT" and "13:00–19:00" in reasons["taxi_late"].reason
    assert_option_is_the_evaluated_plan(raw, answer, answer.options[0])


def test_the_trip_own_lock_does_not_restrict_its_places() -> None:
    raw = busy_day()
    for t in raw["trips"]:
        if t["id"] == "t_new":
            t["lockedVehicleId"] = "taxi_late"
    assert [o.vehicle_id for o in insert(raw, "t_new").options] == ["taxi_free"]


def test_options_are_ranked_by_margin() -> None:
    raw = busy_day()
    raw["vehicles"].append(vehicle("taxi_dear", MARSEILLE, cost_per_km=0.9, cost_per_hour=40))
    answer = insert(raw, "t_new")
    assert [o.vehicle_id for o in answer.options] == ["taxi_free", "taxi_dear"]
    assert answer.options[0].delta_margin > answer.options[1].delta_margin
    assert answer.options[0].delta_km == pytest.approx(answer.options[1].delta_km)


# --------------------------------------------------------------------------- large seed


@pytest.fixture(scope="module")
def fleet_day() -> dict[str, Any]:
    raw = json.load(gzip.open(SEED_FLEET_DAY))
    raw["routes"] = raw.pop("initialRoutes")
    return raw


def test_large_seed_answers_within_budget_and_each_best_place_is_valid(fleet_day: dict[str, Any]) -> None:
    raw = fleet_day
    picked = [stop["tripId"] for route in raw["routes"] for stop in route["stops"] if stop["kind"] == "PICKUP"]
    served = set(picked)
    trip_ids = [*picked[::60], *(t["id"] for t in raw["trips"] if t["id"] not in served)]
    for trip_id in trip_ids:
        began = time.perf_counter()
        answer = insert(raw, trip_id)
        assert time.perf_counter() - began < FLEET_BUDGET_SEC, trip_id
        assert answer.from_vehicle_id == next((r["vehicleId"] for r in raw["routes"] if any(s["tripId"] == trip_id for s in r["stops"])), None)
        assert [o.delta_margin for o in answer.options] == sorted((o.delta_margin for o in answer.options), reverse=True)
        listed = [o.vehicle_id for o in answer.options] + [r.vehicle_id for r in answer.rejected]
        assert len(listed) == len(set(listed)) and answer.from_vehicle_id not in listed
        if answer.options:
            assert_option_is_the_evaluated_plan(raw, answer, answer.options[0])
