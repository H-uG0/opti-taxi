"""Run by tests/test_search.py in subprocesses, one per PYTHONHASHSEED (not collected by pytest).

Prints as JSON what must not depend on the hash seed: the node layout of the model of a generated
day, the plan of a search stopped by a solution limit rather than by the clock (the LNS
sub-searches of OR-Tools, bounded to 100 ms by default, get a long limit too), and that plan after
the final check and the pair pass (guarded, restore_pairs).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from app import solver
from app.context import make_context, request_points
from app.matrix import build_matrix
from app.schemas import OptimizeRequest
from tests.builders import generated_day

SOLUTION_LIMIT = 10
GUARD_SEC = 120
"""Time limit of every phase: a guard only, the solution limit stops the search long before."""


def _counted(original: Callable[..., Any]) -> Callable[..., Any]:
    def params(self: solver._DayModel, seconds: float, *, first_solution_only: bool = False) -> Any:
        parameters = original(self, GUARD_SEC, first_solution_only=first_solution_only)
        parameters.lns_time_limit.FromSeconds(GUARD_SEC)
        if not first_solution_only:
            parameters.solution_limit = SOLUTION_LIMIT
        return parameters

    return params


def main() -> None:
    solver._DayModel._params = _counted(solver._DayModel._params)  # type: ignore[method-assign]
    request = OptimizeRequest.model_validate(generated_day(time_limit_sec=GUARD_SEC))
    ctx = make_context(request, build_matrix(request_points(request))[0])
    fleet, _ = solver.usable_fleet(ctx)
    routable = []
    for trip in request.trips:
        candidates, reason = solver.screen_trip(ctx, trip, fleet)
        if reason is None:
            routable.append((trip, candidates))
    model = solver._DayModel(ctx, fleet, routable)
    solution = model.search(GUARD_SEC)
    assert solution is not None
    routes = model.routes_of(solution)
    plan = model.sequences(routes)
    left_out = model.guarded(routes, GUARD_SEC)
    restored = model.restore_pairs(routes, GUARD_SEC)
    print(
        json.dumps(
            {
                "nodes": [[n.role.value, n.point, n.trip.id if n.trip else None, n.vehicle] for n in model.nodes],
                "candidates": [[trip.id, candidates] for trip, candidates in routable],
                "plan": {vid: [[ref.trip_id, ref.kind] for ref in refs] for vid, refs in plan.items()},
                "objective": solution.ObjectiveValue(),
                "final": {
                    "plan": {vid: [[ref.trip_id, ref.kind] for ref in refs] for vid, refs in model.sequences(routes).items()},
                    "leftOut": left_out,
                    "restored": restored,
                },
            }
        )
    )


if __name__ == "__main__":
    main()
