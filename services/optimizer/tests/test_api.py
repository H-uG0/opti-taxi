"""HTTP API: routes, camelCase JSON, contract round trip and 422 on invalid input."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas import InsertResponse, PlanResponse
from tests.builders import load_fixture

client = TestClient(app)


def test_health_reports_straight_line_without_osrm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OSRM_URL", raising=False)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "matrixSource": "haversine"}


def test_health_reports_osrm_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OSRM_URL", "http://osrm.test:5000")
    assert client.get("/health").json()["matrixSource"] == "osrm"


def test_optimize_returns_a_contract_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OSRM_URL", raising=False)
    body = load_fixture("optimize-request.json")
    body["settings"]["timeLimitSec"] = 1
    response = client.post("/optimize", json=body)
    assert response.status_code == 200
    data = response.json()
    assert {"routes", "trips", "unassigned", "kpis", "validation", "meta"} <= data.keys()
    assert "vehicleId" in data["routes"][0] and "coPassengerTripIds" in data["trips"][0]
    plan = PlanResponse.model_validate(data)
    assert plan.validation.valid
    assert plan.meta.matrix_source == "haversine"


def test_evaluate_returns_a_contract_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OSRM_URL", raising=False)
    response = client.post("/evaluate", json=load_fixture("evaluate-request.json"))
    assert response.status_code == 200
    data = response.json()
    assert data["meta"]["solverStatus"] == "EVALUATE"
    assert any(route.get("break") is not None for route in data["routes"])
    assert PlanResponse.model_validate(data).validation.valid


def test_insert_returns_the_places_of_a_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OSRM_URL", raising=False)
    response = client.post("/insert", json=load_fixture("insert-request.json"))
    assert response.status_code == 200
    data = response.json()
    assert {"tripId", "fromVehicleId", "options", "rejected", "meta"} == data.keys()
    assert data["meta"]["solverStatus"] == "INSERT"
    assert "deltaMargin" in data["options"][0] and "pickupShiftMin" in data["options"][0]["shifts"][0]
    assert InsertResponse.model_validate(data).options[0].vehicle_id == "veh_taxi_1"
    body = load_fixture("insert-request.json")
    body["tripId"] = "trip_404"
    assert client.post("/insert", json=body).status_code == 422


def test_optimize_falls_back_when_osrm_is_down(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OSRM_URL", "http://127.0.0.1:9")
    body = load_fixture("evaluate-request.json")
    response = client.post("/evaluate", json=body)
    assert response.status_code == 200
    meta = response.json()["meta"]
    assert meta["matrixSource"] == "haversine"
    assert any("Distances routières indisponibles" in warning for warning in meta["warnings"])
    assert not any("OSRM" in warning for warning in meta["warnings"])


def test_invalid_request_is_rejected_with_422() -> None:
    body = load_fixture("optimize-request.json")
    body["trips"][0]["appointmentMin"] = None
    assert client.post("/optimize", json=body).status_code == 422
    body = load_fixture("optimize-request.json")
    body["unexpected"] = True
    assert client.post("/optimize", json=body).status_code == 422
    assert client.post("/evaluate", json=load_fixture("optimize-request.json")).status_code == 422
