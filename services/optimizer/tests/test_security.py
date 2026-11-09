"""API protections: token (401), concurrent solves (429), body size (413), request bounds (422)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app
from app.schemas import MAX_TRIPS, MAX_VEHICLES
from app.security import BodySizeLimit, SolveSlots, max_concurrent_solves
from tests.builders import load_fixture

client = TestClient(app)


def _fast_body() -> dict:
    body = load_fixture("optimize-request.json")
    body["settings"]["timeLimitSec"] = 1
    return body


@pytest.fixture(autouse=True)
def _straight_line(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OSRM_URL", raising=False)


def test_without_a_configured_token_the_api_stays_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPTIMIZER_TOKEN", raising=False)
    assert client.post("/evaluate", json=load_fixture("evaluate-request.json")).status_code == 200


def test_a_configured_token_is_required_on_optimize_and_evaluate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPTIMIZER_TOKEN", "jeton-de-test")
    for path, body in (("/optimize", _fast_body()), ("/evaluate", load_fixture("evaluate-request.json"))):
        missing = client.post(path, json=body)
        assert missing.status_code == 401
        assert missing.headers["www-authenticate"] == "Bearer"
        assert "OPTIMIZER_TOKEN" in missing.json()["detail"]
        wrong = client.post(path, json=body, headers={"Authorization": "Bearer autre-jeton"})
        assert wrong.status_code == 401
        not_bearer = client.post(path, json=body, headers={"Authorization": "Basic jeton-de-test"})
        assert not_bearer.status_code == 401
    good = client.post("/evaluate", json=load_fixture("evaluate-request.json"), headers={"Authorization": "Bearer jeton-de-test"})
    assert good.status_code == 200


def test_the_token_is_checked_before_the_body(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPTIMIZER_TOKEN", "jeton-de-test")
    assert client.post("/optimize", json={"not": "a request"}).status_code == 401


def test_health_needs_no_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPTIMIZER_TOKEN", "jeton-de-test")
    assert client.get("/health").status_code == 200


def test_a_solve_beyond_the_concurrent_limit_gets_429(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPTIMIZER_TOKEN", raising=False)
    slots = SolveSlots(1)
    monkeypatch.setattr(main, "solve_slots", slots)
    with slots.hold():
        busy = client.post("/optimize", json=_fast_body())
        assert busy.status_code == 429
        assert busy.headers["retry-after"] == "30"
        assert "Réessayez" in busy.json()["detail"]
        # /evaluate runs no solver: not counted.
        assert client.post("/evaluate", json=load_fixture("evaluate-request.json")).status_code == 200
    # The slot is free again once the running solve is over, also after a refused one.
    assert client.post("/optimize", json=_fast_body()).status_code == 200


def test_a_failed_solve_releases_its_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    slots = SolveSlots(1)

    def boom(*_args: object) -> None:
        raise RuntimeError("solver crashed")

    with pytest.raises(RuntimeError), slots.hold():
        boom()
    with slots.hold():
        pass


def test_concurrent_solves_setting_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPTIMIZER_MAX_CONCURRENT_SOLVES", raising=False)
    assert max_concurrent_solves() == 2
    monkeypatch.setenv("OPTIMIZER_MAX_CONCURRENT_SOLVES", "1")
    assert max_concurrent_solves() == 1
    for bad in ("0", "99", "deux"):
        monkeypatch.setenv("OPTIMIZER_MAX_CONCURRENT_SOLVES", bad)
        assert max_concurrent_solves() == 2


def test_an_oversized_body_gets_413_whether_declared_or_streamed() -> None:
    small = TestClient(BodySizeLimit(app, max_bytes=1024))
    body = json.dumps(_fast_body()).encode()
    assert len(body) > 1024
    declared = small.post("/optimize", content=body, headers={"content-type": "application/json"})
    assert declared.status_code == 413
    assert "trop volumineuse" in declared.json()["detail"]

    def chunks():
        for start in range(0, len(body), 256):
            yield body[start : start + 256]

    streamed = small.post("/optimize", content=chunks(), headers={"content-type": "application/json"})
    assert streamed.status_code == 413


def test_vehicle_and_trip_counts_are_bounded_by_the_contract() -> None:
    body = _fast_body()
    body["trips"] = [body["trips"][0]] * (MAX_TRIPS + 1)
    assert client.post("/optimize", json=body).status_code == 422
    body = _fast_body()
    body["vehicles"] = [body["vehicles"][0]] * (MAX_VEHICLES + 1)
    assert client.post("/optimize", json=body).status_code == 422
