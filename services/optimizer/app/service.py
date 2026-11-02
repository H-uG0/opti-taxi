"""The two operations of the service, independent of HTTP: optimize a day, evaluate a given plan."""

from __future__ import annotations

import logging
import time

from app.context import make_context, request_points
from app.matrix import build_matrix, configured_osrm_url
from app.plan import PlanOutcome, build_response
from app.schemas import EvaluateRequest, OptimizeRequest, PlanResponse
from app.solver import solve
from app.validator import check_plan_references

logger = logging.getLogger("optimizer")

REASON_NOT_PLANNED = "Non planifiée"
REASON_NOT_ROUTED = "Non affectée"


def optimize(request: OptimizeRequest) -> PlanResponse:
    """Routes of the day computed by the solver, recomputed and validated."""
    started = time.perf_counter()
    matrix, warnings = build_matrix(request_points(request), configured_osrm_url())
    ctx = make_context(request, matrix)
    warnings.extend(ctx.tariffs.missing_warnings(request.vehicles))
    solve_started = time.perf_counter()
    outcome = solve(ctx)
    solve_ms = round((time.perf_counter() - solve_started) * 1000)
    warnings.extend(outcome.warnings)
    response = build_response(
        ctx,
        PlanOutcome(
            sequences=outcome.sequences,
            unassigned_reasons=outcome.unassigned,
            default_reason=REASON_NOT_ROUTED,
            status=outcome.status,
            solver_status=outcome.solver_status,
            objective=outcome.objective,
            warnings=warnings,
        ),
        started,
    )
    if not response.validation.valid:
        logger.warning(
            "optimize %s: solver plan has %d violation(s): %s",
            request.date,
            len(response.validation.violations),
            "; ".join(f"{v.code} {v.trip_id or v.vehicle_id}" for v in response.validation.violations[:5]),
        )
    logger.info(
        "optimize %s: %d trips, %d vehicles, served %d, solve %d ms, total %d ms, matrix %s, status %s",
        request.date,
        len(request.trips),
        len(request.vehicles),
        response.kpis.trips_served,
        solve_ms,
        response.meta.wall_time_ms,
        matrix.source,
        outcome.solver_status,
    )
    return response


def evaluate(request: EvaluateRequest) -> PlanResponse:
    """Times, km, revenue and violations of the regulator's plan (stop order as given)."""
    started = time.perf_counter()
    matrix, warnings = build_matrix(request_points(request), configured_osrm_url())
    ctx = make_context(request, matrix)
    warnings.extend(ctx.tariffs.missing_warnings(request.vehicles))
    sequences, reference_violations, reference_warnings = check_plan_references(request, request.routes)
    warnings.extend(reference_warnings)
    response = build_response(
        ctx,
        PlanOutcome(
            sequences=sequences,
            unassigned_reasons={},
            default_reason=REASON_NOT_PLANNED,
            status="OK",
            solver_status="EVALUATE",
            objective=None,
            warnings=warnings,
            extra_violations=reference_violations,
        ),
        started,
    )
    logger.info(
        "evaluate %s: %d routes, %d violation(s), %d ms",
        request.date,
        len(response.routes),
        len(response.validation.violations),
        response.meta.wall_time_ms,
    )
    return response
