"""Hours of the facility (trips[].facilityOpenMin / facilityCloseMin, PAT-04): they narrow the window of
the trip's stop at the facility, the solver keeps to them and the validator checks them on its own."""

from __future__ import annotations

import time
from typing import Any

from app import service
from app.context import make_context, request_points
from app.matrix import build_matrix
from app.model import derive_windows, facility_hours_apply, facility_hours_warnings
from app.plan import PlanOutcome, build_response
from app.schemas import OptimizeRequest, StopRef
from app.validator import validate
from tests.builders import AIX, MARSEILLE, offset, request, trip, vehicle

HOME = offset(MARSEILLE, 3, 2)
AIX_FAC = (43.5260, 5.4380)


def day(**hours: Any) -> dict[str, Any]:
    outbound = trip("out", "pat_a", "OUTBOUND", HOME, AIX_FAC, appointment=480)
    back = trip("ret", "pat_a", "RETURN", AIX_FAC, HOME, ready=1000)
    for t in (outbound, back):
        t.update(hours)
    return request([vehicle("taxi_1", MARSEILLE), vehicle("taxi_2", AIX)], [outbound, back])


def test_without_hours_the_windows_are_unchanged() -> None:
    windows = derive_windows(OptimizeRequest.model_validate(day()))
    assert (windows["out"].dropoff.open, windows["out"].dropoff.close) == (450, 480)
    assert (windows["ret"].pickup.open, windows["ret"].pickup.close) == (1000, 1015)


def test_the_hours_narrow_the_stop_at_the_facility() -> None:
    request_ = OptimizeRequest.model_validate(day(facilityOpenMin=465, facilityCloseMin=1005))
    windows = derive_windows(request_)
    # Outbound: no arrival before 07:45; return: picked up by 16:45, the facility closing then.
    assert (windows["out"].dropoff.open, windows["out"].dropoff.close) == (465, 480)
    assert (windows["ret"].pickup.open, windows["ret"].pickup.close) == (1000, 1005)
    assert facility_hours_warnings(request_) == []


def test_a_time_outside_the_hours_ignores_them_with_a_warning() -> None:
    request_ = OptimizeRequest.model_validate(day(facilityOpenMin=500, facilityCloseMin=990))
    assert not any(facility_hours_apply(t) for t in request_.trips)
    windows = derive_windows(request_)
    assert (windows["out"].dropoff.open, windows["out"].dropoff.close) == (450, 480)
    assert facility_hours_warnings(request_) == [
        "Course out : rendez-vous à 08:00 hors des heures d'accueil de l'établissement, heures ignorées",
        "Course ret : fin de séance à 16:40 hors des heures d'accueil de l'établissement, heures ignorées",
    ]


def test_the_solver_keeps_to_the_hours_and_the_plan_is_valid() -> None:
    plan = service.optimize(OptimizeRequest.model_validate(day(facilityOpenMin=470, facilityCloseMin=1005)))
    assert plan.validation.valid, plan.validation.violations
    stops = {(s.trip_id, s.kind): s for r in plan.routes for s in r.stops}
    assert 470 <= stops[("out", "DROPOFF")].start_min <= 480
    assert 1000 <= stops[("ret", "PICKUP")].start_min <= 1005


def test_the_validator_checks_the_hours_on_its_own() -> None:
    # Planned without hours (arrival from 07:30 on), then judged with an opening at 07:55.
    raw = day()
    parsed = OptimizeRequest.model_validate(raw)
    matrix, _ = build_matrix(request_points(parsed))
    ctx = make_context(parsed, matrix)
    refs = {"taxi_1": [StopRef(trip_id="out", kind="PICKUP"), StopRef(trip_id="out", kind="DROPOFF")]}
    routes = list(build_response(ctx, PlanOutcome(refs, {}, "Non planifiée", "OK", "TEST", None), time.perf_counter()).routes)
    arrival = next(s for s in routes[0].stops if s.kind == "DROPOFF").start_min
    assert arrival < 475
    judged = OptimizeRequest.model_validate(day(facilityOpenMin=475, facilityCloseMin=1200))
    found = [v for v in validate(judged, routes, matrix) if v.trip_id == "out"]
    assert [v.code for v in found] == ["TIME_WINDOW"]
    assert "avant l'accueil de l'établissement (07:55)" in found[0].message
    # Hours that leave the appointment outside are ignored by the validator too.
    ignored = OptimizeRequest.model_validate(day(facilityOpenMin=485))
    assert [v for v in validate(ignored, routes, matrix) if v.trip_id == "out"] == []
