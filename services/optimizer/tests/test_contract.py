"""The pydantic models must accept every contract fixture (mirror of contract.test.ts)."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas import EvaluateRequest, InsertRequest, InsertResponse, OptimizeRequest, PlanResponse

FIXTURES = Path(__file__).resolve().parents[3] / "contract" / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_optimize_request_fixture() -> None:
    request = OptimizeRequest.model_validate(load("optimize-request.json"))
    assert request.trips
    assert request.initial_routes and request.initial_routes[0].stops


def test_initial_routes_are_optional_and_not_part_of_evaluate() -> None:
    raw = load("optimize-request.json")
    in_place = raw.pop("initialRoutes")
    assert OptimizeRequest.model_validate(raw).initial_routes is None
    assert OptimizeRequest.model_validate({**raw, "initialRoutes": None}).initial_routes is None
    with pytest.raises(ValidationError):
        EvaluateRequest.model_validate({**load("evaluate-request.json"), "initialRoutes": in_place})


def test_evaluate_request_fixture() -> None:
    request = EvaluateRequest.model_validate(load("evaluate-request.json"))
    assert request.routes


def test_plan_response_fixture_round_trips() -> None:
    raw = load("plan-response.json")
    response = PlanResponse.model_validate(raw)
    assert response.model_dump(mode="json", by_alias=True) == raw


def test_insert_request_fixture() -> None:
    request = InsertRequest.model_validate(load("insert-request.json"))
    assert request.trip_id == "trip_1" and request.routes and request.vehicle_ids is None
    assert all(stop.trip_id != request.trip_id for route in request.routes for stop in route.stops)


def test_insert_request_needs_a_known_trip_and_takes_no_initial_routes() -> None:
    raw = load("insert-request.json")
    with pytest.raises(ValidationError):
        InsertRequest.model_validate({**raw, "tripId": "trip_404"})
    with pytest.raises(ValidationError):
        InsertRequest.model_validate({**raw, "initialRoutes": raw["routes"]})
    assert InsertRequest.model_validate({**raw, "vehicleIds": ["veh_vsl_1"]}).vehicle_ids == ["veh_vsl_1"]


def test_insert_response_fixture_round_trips() -> None:
    raw = load("insert-response.json")
    response = InsertResponse.model_validate(raw)
    assert response.options and response.rejected
    assert response.model_dump(mode="json", by_alias=True) == raw


def test_outbound_requires_appointment() -> None:
    raw = load("optimize-request.json")
    raw["trips"][0]["appointmentMin"] = None
    with pytest.raises(ValidationError):
        OptimizeRequest.model_validate(raw)


def test_unknown_fields_rejected() -> None:
    raw = load("optimize-request.json")
    raw["extra"] = 1
    with pytest.raises(ValidationError):
        OptimizeRequest.model_validate(raw)
