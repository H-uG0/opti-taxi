"""Scale benchmark, run by hand (not collected by pytest): one optimize + one evaluate of fleet_day().

    python -m tests.bench_fleet --vehicles 120 --trips 300 --budget 38

Prints one JSON object: what the regulator gets (trips served, km, sharing, reasons), the time of each
phase and the peak memory. Fictitious data, straight-line matrix unless OSRM_URL is set.
"""

from __future__ import annotations

import argparse
import json
import logging
import resource
import statistics
import time
from collections import Counter

from app import service
from app.schemas import EvaluateRequest, OptimizeRequest
from tests.builders import fleet_day


class _Keep(logging.Handler):
    """Keeps the phase timings the solver logs."""

    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vehicles", type=int, default=120)
    parser.add_argument("--trips", type=int, default=300)
    parser.add_argument("--budget", type=int, default=38, help="settings.timeLimitSec")
    parser.add_argument("--seed", type=int, default=3)
    parser.add_argument("--long-share", type=float, default=0.5)
    parser.add_argument("--grids", choices=("official", "simple"), default="official", help="tariff grids of the day")
    args = parser.parse_args()

    keep = _Keep()
    logging.getLogger().addHandler(keep)
    logging.getLogger().setLevel(logging.INFO)

    raw = fleet_day(
        args.vehicles, args.trips, seed=args.seed, long_share=args.long_share, time_limit_sec=args.budget, grids=args.grids
    )
    request = OptimizeRequest.model_validate(raw)

    started = time.perf_counter()
    plan = service.optimize(request)
    optimize_sec = time.perf_counter() - started

    routes = [{"vehicleId": r.vehicle_id, "stops": [{"tripId": s.trip_id, "kind": s.kind} for s in r.stops]} for r in plan.routes]
    evaluate_request = EvaluateRequest.model_validate({**raw, "routes": routes})
    started = time.perf_counter()
    evaluation = service.evaluate(evaluate_request)
    evaluate_sec = time.perf_counter() - started

    direct = sorted(t.direct_km for t in plan.trips)
    served_per_vehicle = Counter(t.vehicle_id for t in plan.trips if t.vehicle_id is not None)
    print(
        json.dumps(
            {
                "vehicles": args.vehicles,
                "trips": args.trips,
                "seed": args.seed,
                "longShare": args.long_share,
                "budgetSec": args.budget,
                "optimizeSec": round(optimize_sec, 1),
                "evaluateSec": round(evaluate_sec, 2),
                "peakMemMb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
                "valid": plan.validation.valid,
                "violations": dict(Counter(v.code for v in plan.validation.violations)),
                "evaluateValid": evaluation.validation.valid,
                "solverStatus": plan.meta.solver_status,
                "served": plan.kpis.trips_served,
                "unassigned": plan.kpis.trips_unassigned,
                "vehiclesUsed": plan.kpis.vehicles_used,
                "tripsPerUsedVehicle": plan.kpis.trips_per_vehicle,
                "tripsPerFleetVehicle": round(plan.kpis.trips_served / args.vehicles, 2),
                "maxTripsOnAVehicle": max(served_per_vehicle.values(), default=0),
                "totalKm": round(plan.kpis.total_km),
                "emptyKmRatio": plan.kpis.empty_km_ratio,
                "sharedTripRatio": plan.kpis.shared_trip_ratio,
                "revenue": round(plan.kpis.revenue),
                "cost": round(plan.kpis.cost),
                "margin": round(plan.kpis.margin),
                "medianDirectKm": round(statistics.median(direct), 1),
                "requestKb": round(len(evaluate_request.model_dump_json(by_alias=True)) / 1024),
                "responseKb": round(len(plan.model_dump_json(by_alias=True)) / 1024),
                "reasons": dict(Counter(u.reason[:70] for u in plan.unassigned)),
                "warnings": plan.meta.warnings,
                "log": [line for line in keep.lines if line.startswith(("solver:", "optimize"))],
            },
            ensure_ascii=False,
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
