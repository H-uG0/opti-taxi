"""The pydantic models must accept every contract fixture (mirror of contract.test.ts)."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas import EvaluateRequest, OptimizeRequest, PlanResponse

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
