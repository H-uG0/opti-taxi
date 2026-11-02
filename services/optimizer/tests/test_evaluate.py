"""/evaluate logic: recompute a given plan and report its violations."""

from __future__ import annotations

import pytest

from app import service
from app.schemas import EvaluateRequest, PlanResponse
from tests.builders import evaluate_request, load_fixture


@pytest.fixture(scope="module")
def fixture_evaluation() -> PlanResponse:
    return service.evaluate(EvaluateRequest.model_validate(load_fixture("evaluate-request.json")))


def test_fixture_plan_is_recomputed_and_valid(fixture_evaluation: PlanResponse) -> None:
    plan = fixture_evaluation
    assert plan.status == "OK"
    assert plan.meta.solver_status == "EVALUATE" and plan.meta.objective is None
    assert plan.validation.valid, plan.validation.violations
    assert {r.vehicle_id for r in plan.routes} == {"veh_taxi_1", "veh_amb_1", "veh_vsl_1"}
    assert plan.kpis.trips_served == 7 and plan.unassigned == []


def test_fixture_metrics_are_consistent(fixture_evaluation: PlanResponse) -> None:
    for route in fixture_evaluation.routes:
        assert route.duration_min == route.end_min - route.start_min
        assert route.distance_km == pytest.approx(route.empty_km + route.loaded_km, abs=0.011)
        assert route.margin == pytest.approx(route.revenue - route.cost, abs=0.011)
        for before, after in zip(route.stops, route.stops[1:], strict=False):
            assert before.departure_min <= after.arrival_min <= after.start_min
    results = {t.trip_id: t for t in fixture_evaluation.trips}
    assert results["trip_1"].shared and results["trip_1"].co_passenger_trip_ids == ["trip_3"]
    assert results["trip_1"].detour_km == pytest.approx(results["trip_1"].ride_km - results["trip_1"].direct_km, abs=0.011)
    assert results["trip_5"].wait_at_facility_min is not None and 0 <= results["trip_5"].wait_at_facility_min <= 30
    kpis = fixture_evaluation.kpis
    assert kpis.total_km == pytest.approx(sum(r.distance_km for r in fixture_evaluation.routes), abs=0.011)
    assert kpis.shared_trips == 4


def test_manual_move_breaking_rules_is_reported() -> None:
    raw = load_fixture("optimize-request.json")
    request = evaluate_request(
        raw,
        {
            # trip_7 is locked on the VSL and trip_5 needs an ambulance.
            "veh_taxi_1": [("trip_7", "PICKUP"), ("trip_7", "DROPOFF"), ("trip_5", "PICKUP"), ("trip_5", "DROPOFF")],
            "veh_amb_1": [("trip_6", "DROPOFF"), ("trip_6", "PICKUP")],
        },
    )
    plan = service.evaluate(request)
    found = {(v.code, v.trip_id) for v in plan.validation.violations}
    assert ("LOCK", "trip_7") in found
    assert ("VEHICLE_TYPE", "trip_5") in found
    assert ("PAIRING", "trip_6") in found
    assert not plan.validation.valid
    reasons = {u.trip_id: u.reason for u in plan.unassigned}
    assert reasons == {trip_id: "Non planifiée" for trip_id in ("trip_1", "trip_2", "trip_3", "trip_4")}


def test_unknown_references_and_duplicates_are_reported() -> None:
    raw = load_fixture("optimize-request.json")
    request = evaluate_request(
        raw,
        {
            "veh_ghost": [("trip_1", "PICKUP")],
            "veh_vsl_1": [("trip_7", "PICKUP"), ("trip_7", "DROPOFF"), ("trip_7", "DROPOFF"), ("trip_x", "PICKUP")],
        },
    )
    plan = service.evaluate(request)
    codes = [v.code for v in plan.validation.violations]
    assert codes.count("UNKNOWN_REFERENCE") == 2
    assert "DUPLICATE_TRIP" in codes
    vsl = plan.routes[0]
    assert [(s.trip_id, s.kind) for s in vsl.stops] == [("trip_7", "PICKUP"), ("trip_7", "DROPOFF")]
