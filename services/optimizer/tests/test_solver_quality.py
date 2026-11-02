"""Search quality on a busy day: 160 trips, 16 vehicles, driver breaks, mixed shifts, locks.

At the default budget of the web app (10 s) the plan must be valid, every driver must get a break,
and the number of trips served must stay close to what a long run reaches. The long-run reference
is a measured figure (`REFERENCE_SERVED_LONG_RUN`, haversine matrix); the direct comparison with
a 30 s run is slow and only runs with OPTIMIZER_SLOW_TESTS=1.
"""

from __future__ import annotations

import logging
import os

import pytest

from app import service, solver
from app.schemas import OptimizeRequest, PlanResponse
from tests.builders import busy_day, busy_fleet

logger = logging.getLogger(__name__)

DEFAULT_BUDGET_SEC = 10
"""Default `solverTimeLimitSec` of the web app."""
LONG_BUDGET_SEC = 30
REFERENCE_SERVED_LONG_RUN = 139
"""Best known number of trips of busy_day() served: a 30 s run of the current search
(development machine; 134 for a 30 s run of the search before the reinsertion step). The current
search serves 129 from 1 s to 20 s, 129 to 139 at 30 s depending on the machine load."""
MIN_SERVED_RATIO = 0.8
"""Trips served at the default budget, relative to the long run."""


def optimize(time_limit_sec: int) -> PlanResponse:
    return service.optimize(OptimizeRequest.model_validate(busy_day(time_limit_sec=time_limit_sec)))


@pytest.fixture(scope="module")
def busy_plan() -> PlanResponse:
    return optimize(DEFAULT_BUDGET_SEC)


def test_busy_day_plan_is_valid_and_every_driver_gets_a_break(busy_plan: PlanResponse) -> None:
    assert busy_plan.validation.valid, busy_plan.validation.violations[:5]
    with_break_rule = {v["id"] for v in busy_fleet() if v["break"] is not None}
    for route in busy_plan.routes:
        if route.vehicle_id in with_break_rule:
            assert route.break_ is not None, route.vehicle_id


def test_busy_day_serves_most_trips_at_the_default_budget(busy_plan: PlanResponse) -> None:
    served = busy_plan.kpis.trips_served
    ratio = served / REFERENCE_SERVED_LONG_RUN
    logger.info("busy day: %d trips served in %d s, %.0f %% of a %d s run", served, DEFAULT_BUDGET_SEC, ratio * 100, LONG_BUDGET_SEC)
    assert ratio >= MIN_SERVED_RATIO, f"{served} trips served in {DEFAULT_BUDGET_SEC} s, {ratio:.0%} of a long run"


def test_busy_day_unplaced_trips_say_whether_more_time_would_help(busy_plan: PlanResponse) -> None:
    reasons = {u.reason for u in busy_plan.unassigned}
    cut_short = solver.search_cut_short(busy_plan.meta.solver_status)
    expected, other = (
        (solver.REASON_DROPPED_TIME_LIMIT, solver.REASON_DROPPED)
        if cut_short
        else (solver.REASON_DROPPED, solver.REASON_DROPPED_TIME_LIMIT)
    )
    assert other not in reasons
    assert expected in reasons or busy_plan.kpis.trips_unassigned == 0
    warned = any(w.startswith("Recherche interrompue par la limite") for w in busy_plan.meta.warnings)
    assert warned == (cut_short and solver.REASON_DROPPED_TIME_LIMIT in reasons)


def test_tiny_budget_still_completes_the_first_solution_and_the_breaks() -> None:
    """With 1 s, the insertion heuristic needs more than the budget: it may finish
    (solver.FIRST_SOLUTION_GRACE_SEC) and the breaks are repaired, instead of an empty or invalid plan."""
    plan = optimize(1)
    assert plan.validation.valid, plan.validation.violations[:5]
    assert plan.kpis.trips_served >= 100
    assert any(w.startswith("Recherche interrompue par la limite de 1 s") for w in plan.meta.warnings)


@pytest.mark.skipif(not os.environ.get("OPTIMIZER_SLOW_TESTS"), reason="30 s run: set OPTIMIZER_SLOW_TESTS=1")
def test_default_budget_reaches_most_of_a_long_run(busy_plan: PlanResponse) -> None:
    long_run = optimize(LONG_BUDGET_SEC)
    assert long_run.validation.valid, long_run.validation.violations[:5]
    ratio = busy_plan.kpis.trips_served / long_run.kpis.trips_served
    logger.info(
        "busy day: %d trips in %d s, %d in %d s (ratio %.2f)",
        busy_plan.kpis.trips_served,
        DEFAULT_BUDGET_SEC,
        long_run.kpis.trips_served,
        LONG_BUDGET_SEC,
        ratio,
    )
    assert ratio >= MIN_SERVED_RATIO
