"""Search mechanics: reinsertion after the break repair, break moves, the plan built from the
breaks, the fallback when the first solution fails, and independence from PYTHONHASHSEED."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from ortools.constraint_solver import pywrapcp, routing_parameters_pb2

from app import service, solver
from app.context import PlanContext, make_context, request_points
from app.matrix import build_matrix
from app.plan import PlanOutcome, build_response
from app.schemas import LatLng, OptimizeRequest, PlanResponse
from tests.builders import (
    FACILITIES,
    GAP,
    MARSEILLE,
    SISTERON,
    STANDARD_BREAK,
    busy_day,
    generated_day,
    latlng,
    offset,
    request,
    trip,
    vehicle,
)

AIX_FAC = (43.5260, 5.4380)
OPTIMIZER_ROOT = Path(__file__).resolve().parents[1]
NO_DEADLINE_SEC = 300.0
"""Deadline of the Python insertions in these tests: never reached, so their result is fixed."""
HASH_SEEDS = ("0", "1", "4242")


def day_model(raw: dict[str, Any]) -> tuple[solver._DayModel, PlanContext]:
    parsed = OptimizeRequest.model_validate(raw)
    ctx = make_context(parsed, build_matrix(request_points(parsed))[0])
    fleet, _ = solver.usable_fleet(ctx)
    routable = []
    for t in parsed.trips:
        candidates, reason = solver.screen_trip(ctx, t, fleet)
        if reason is None:
            routable.append((t, candidates))
    return solver._DayModel(ctx, fleet, routable), ctx


def checked_plan(model: solver._DayModel, ctx: PlanContext, routes: list[list[int]]) -> PlanResponse:
    """Plan of the routes once the routing model accepted them (it rechecks every constraint)."""
    assignment = model.routing.ReadAssignmentFromRoutes(routes, True)
    assert assignment is not None, "routes rejected by the routing model"
    outcome = PlanOutcome(
        sequences=model.sequences(assignment),
        unassigned_reasons={},
        default_reason="-",
        status="OK",
        solver_status="TEST",
        objective=None,
    )
    return build_response(ctx, outcome, time.perf_counter())


def holds_every_break(model: solver._DayModel, routes: list[list[int]]) -> bool:
    return all(any(model.node_at(index).role is solver.Role.BREAK for index in routes[v]) for v in model.break_nodes)


def first_solution(model: solver._DayModel) -> pywrapcp.Assignment:
    solution = model.routing.SolveWithParameters(model._params(NO_DEADLINE_SEC, first_solution_only=True))
    assert solution is not None
    return solution


def test_regret_insertion_order() -> None:
    """A trip with a single option goes first, then the largest gap between best and second best."""
    options: dict[str, dict[int, tuple[float, list[int]]]] = {
        "anywhere": {0: (100.0, []), 1: (110.0, [])},
        "only_one": {2: (500.0, [])},
        "picky": {0: (50.0, []), 1: (300.0, [])},
    }
    assert solver._DayModel._next_insertion(options) == ("only_one", 2)
    del options["only_one"]
    assert solver._DayModel._next_insertion(options) == ("picky", 0)


def test_reinsertion_moves_the_break_when_the_trip_needs_its_slot() -> None:
    """Break window 11:30-12:40 (start by 11:55): with the break kept at the depot, a trip arriving
    at the Aix facility for 12:00 fits neither before it (back in Marseille too late) nor after it
    (late for the appointment); the break moves to the facility, right after the dropoff."""
    rule = {"windowStartMin": 690, "windowEndMin": 760, "durationMin": 45}
    trips = [trip("noon", "p1", "OUTBOUND", offset(AIX_FAC, 3, 0), AIX_FAC, appointment=720)]
    model, _ = day_model(request([vehicle("taxi", MARSEILLE, break_=rule)], trips))
    route = model._breaks_only_routes()[0]
    assert [model.node_at(index).point for index in route] == [model.nodes[0].point]  # break at the depot
    noon = model.ctx.trips["noon"]
    assert model._first_feasible(0, route, model._insertion_positions(route, 0, noon), noon) is None

    insertion = model._cheapest_insertion(route, 0, noon)
    assert insertion is not None
    stops = [model.node_at(index) for index in insertion[1]]
    assert [stop.role for stop in stops] == [solver.Role.PICKUP, solver.Role.DELIVERY, solver.Role.BREAK]
    assert stops[2].point == stops[1].point  # break taken at the facility
    assert model._time_feasible(0, insertion[1])


def test_break_can_be_taken_where_a_far_lunchtime_return_ends() -> None:
    """Gap taxi, break 11:30-14:00: a return 11:30 to a home in Gap, then a return 12:00 to
    Sisteron (~50 min). The break fits neither before the second return nor at a depot or facility
    after it (back in Gap past 13:15): the Sisteron home becomes a break site, the Gap one does not
    (the depot is minutes away)."""
    gap_fac = FACILITIES["fac_gap_ch"][1]
    near_home, far_home = offset(GAP, 1, 1), offset(SISTERON, 0.5, 0.5)
    trips = [
        trip("near", "p1", "RETURN", gap_fac, near_home, ready=690, facility="fac_gap_ch"),
        trip("far", "p2", "RETURN", gap_fac, far_home, ready=720, facility="fac_gap_ch"),
    ]
    raw = request([vehicle("taxi_gap", GAP, department="05", break_=STANDARD_BREAK)], trips)
    model, _ = day_model(raw)
    sites = [model.nodes[n].point for n in model.break_nodes[0]]
    places = [model.ctx.matrix.index_of(LatLng.model_validate(latlng(point))) for point in (GAP, gap_fac, far_home)]
    assert sites == places

    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.validation.valid, plan.validation.violations[:5]
    assert plan.kpis.trips_served == 2
    assert plan.routes[0].break_ is not None


@pytest.mark.parametrize(("raw", "min_served"), [(generated_day(), 54), (busy_day(), 110)], ids=["generated", "busy"])
def test_plan_built_from_the_breaks_is_exact(raw: dict[str, Any], min_served: int) -> None:
    """The Python insertions (times, seats, exclusive rides, breaks, detours) agree with the
    routing model and with the independent validator, on days with ambulances, locks, mixed
    shifts and breaks."""
    model, ctx = day_model(raw)
    routes = model._built_from_breaks(time.monotonic() + NO_DEADLINE_SEC)
    assert holds_every_break(model, routes)
    plan = checked_plan(model, ctx, routes)
    assert plan.validation.valid, plan.validation.violations[:5]
    assert plan.kpis.trips_served == model._placed_in(routes) >= min_served


@pytest.mark.parametrize("raw", [generated_day(), busy_day()], ids=["generated", "busy"])
def test_break_repair_then_reinsertion_wins_back_dropped_trips(raw: dict[str, Any]) -> None:
    model, ctx = day_model(raw)
    first = first_solution(model)
    start, kept = model._repaired(first, time.monotonic() + NO_DEADLINE_SEC)
    routes = model._routes(start)
    assert holds_every_break(model, routes)
    assert model._placed(start) > kept  # the repair dropped trips, the reinsertion placed some back
    plan = checked_plan(model, ctx, routes)
    assert plan.validation.valid, plan.validation.violations[:5]


def assert_fallback_plan(plan: PlanResponse, min_served: int) -> None:
    """Plan after a failed first solution: valid, every break, the warning, and trips left out
    marked as time-bound (a re-run may place them), never "no room" nor NO_SOLUTION."""
    assert plan.status == "OK"
    assert plan.validation.valid, plan.validation.violations[:5]
    assert plan.routes and all(route.break_ is not None for route in plan.routes)
    assert plan.kpis.trips_served >= min_served
    assert solver.WARNING_FIRST_SOLUTION_FAILED in plan.meta.warnings
    assert {u.reason for u in plan.unassigned} <= {solver.REASON_DROPPED_TIME_LIMIT}


def no_first_solution(self: pywrapcp.RoutingModel, parameters: Any, *_: Any) -> None:
    """Stand-in for SolveWithParameters that closes the model and finds nothing."""
    self.CloseModelWithParameters(parameters)


def test_first_solution_failure_falls_back_to_a_search_from_the_breaks(monkeypatch: pytest.MonkeyPatch) -> None:
    """As on an overloaded machine: the first solve closes the model and returns nothing. A plan
    with every break still comes back, with a warning, never NO_SOLUTION."""
    monkeypatch.setattr(pywrapcp.RoutingModel, "SolveWithParameters", no_first_solution)
    monkeypatch.setattr(solver, "FALLBACK_SEARCH_SEC", 2)
    plan = service.optimize(OptimizeRequest.model_validate(generated_day(time_limit_sec=1)))
    assert_fallback_plan(plan, min_served=45)


def test_first_solution_timeout_falls_back_although_the_routing_limit_is_used_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """Genuine ROUTING_FAIL_TIMEOUT: the real first solve with a 1 ms limit (the generated day
    needs about 0.3 s). The failed solve used up the routing limit, under which
    ReadAssignmentFromRoutes fails: the fallback must still restore its start and search."""
    real_solve = pywrapcp.RoutingModel.SolveWithParameters
    first_solves: list[str] = []

    def timed_out_first_solve(self: pywrapcp.RoutingModel, parameters: Any, *rest: Any) -> Any:
        tight = routing_parameters_pb2.RoutingSearchParameters()
        tight.CopyFrom(parameters)
        tight.time_limit.FromMilliseconds(1)
        solution = real_solve(self, tight, *rest)
        first_solves.append("SOLVED" if solution is not None else solver._status_name(self))
        return solution

    monkeypatch.setattr(pywrapcp.RoutingModel, "SolveWithParameters", timed_out_first_solve)
    monkeypatch.setattr(solver, "FALLBACK_SEARCH_SEC", 2)
    plan = service.optimize(OptimizeRequest.model_validate(generated_day(time_limit_sec=1)))
    if first_solves != ["ROUTING_FAIL_TIMEOUT"]:
        pytest.skip(f"the first solution did not time out in 1 ms on this machine: {first_solves}")
    assert_fallback_plan(plan, min_served=45)


def test_fallback_plan_says_a_rerun_may_place_the_trips_left_out(monkeypatch: pytest.MonkeyPatch) -> None:
    """One taxi with a break, four trips to Aix 30 min apart: one cannot fit and the short fallback
    search reaches a local optimum (ROUTING_SUCCESS). The trip left out still gets the time-limit
    reason, in line with the warning, not "no room in the routes"."""
    trips = [trip(f"t{k}", f"p{k}", "OUTBOUND", offset(MARSEILLE, k, 0), AIX_FAC, appointment=540 + 30 * k) for k in range(4)]
    monkeypatch.setattr(pywrapcp.RoutingModel, "SolveWithParameters", no_first_solution)
    monkeypatch.setattr(solver, "FALLBACK_SEARCH_SEC", 1)
    plan = service.optimize(OptimizeRequest.model_validate(request([vehicle("taxi", MARSEILLE, break_=STANDARD_BREAK)], trips)))
    assert plan.kpis.trips_unassigned >= 1
    assert_fallback_plan(plan, min_served=1)
    assert any(u.reason == solver.REASON_DROPPED_TIME_LIMIT for u in plan.unassigned)


def test_model_and_plan_do_not_depend_on_the_hash_seed() -> None:
    """Same node layout, candidates and plan (search stopped by a solution limit, see
    tests/hashseed_probe.py) under several PYTHONHASHSEED values, in separate interpreters."""
    env = {key: value for key, value in os.environ.items() if key != "OSRM_URL"}
    runs = [
        subprocess.Popen(
            [sys.executable, "-m", "tests.hashseed_probe"],
            cwd=OPTIMIZER_ROOT,
            env={**env, "PYTHONHASHSEED": seed},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for seed in HASH_SEEDS
    ]
    outputs = []
    for run in runs:
        out, err = run.communicate(timeout=600)
        assert run.returncode == 0, err[-2000:]
        outputs.append(json.loads(out.strip().splitlines()[-1]))
    reference = outputs[0]
    assert reference["plan"]
    for seed, other in zip(HASH_SEEDS[1:], outputs[1:], strict=True):
        for key in ("nodes", "candidates", "plan", "objective"):
            assert other[key] == reference[key], f"{key} differs with PYTHONHASHSEED={seed}"
