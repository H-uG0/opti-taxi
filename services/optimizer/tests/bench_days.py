"""Search-quality benchmark, run by hand (not collected by pytest): optimize saved day requests and
print what the objective weighs, day by day.

    python -m tests.bench_days req-2026-11-10.json req-2026-11-11.json --budget 10
    python -m tests.bench_days busy:11 busy:13 generated:7
    python -m tests.bench_days req-2026-11-10.json --warm plan-2026-11-10.json

A file holds an OptimizeRequest, or `{"request": …}` as the web's request dump prints it; `busy:<seed>`
and `generated:<seed>` are the fictitious days of tests/builders.py. `--warm` gives, for each day in
the same order, a PlanResponse (or `{"routes": …}`) whose routes are sent as the plan in place
(`initialRoutes`). Per day: trips served, patients half-served (outbound or return alone), margin,
score (unassignedPenalty per trip left out and per patient not served both ways, minus the margin:
lower is better), violations, wall time and solver status; then the totals. Used for OPT-08
(docs/journal-ameliorations.md).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from app import service
from app.schemas import OptimizeRequest, PlanResponse
from tests.builders import busy_day, generated_day


def load_day(name: str, budget: int | None) -> dict[str, Any]:
    kind, _, seed = name.partition(":")
    if kind == "busy" and seed.isdigit():
        raw = busy_day(seed=int(seed))
    elif kind == "generated" and seed.isdigit():
        raw = generated_day(seed=int(seed))
    else:
        loaded = json.loads(Path(name).read_text(encoding="utf-8"))
        raw = loaded.get("request", loaded)
    if budget is not None:
        raw["settings"]["timeLimitSec"] = budget
    return raw


def half_served(raw: dict[str, Any], plan: PlanResponse) -> tuple[int, int]:
    """(patients with one leg alone served, patients with outbound and return not both served)."""
    left_out = {u.trip_id for u in plan.unassigned}
    legs: dict[str, list[dict[str, Any]]] = {}
    for trip in raw["trips"]:
        legs.setdefault(trip["patientId"], []).append(trip)
    half = broken = 0
    for trips in legs.values():
        if {t["direction"] for t in trips} != {"OUTBOUND", "RETURN"}:
            continue
        missing = sum(1 for t in trips if t["id"] in left_out)
        broken += missing > 0
        half += 0 < missing < len(trips)
    return half, broken


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("days", nargs="+")
    parser.add_argument("--budget", type=int, default=None, help="settings.timeLimitSec (default: the request's)")
    parser.add_argument("--warm", nargs="*", default=None, help="plan in place of each day, same order")
    args = parser.parse_args()

    totals = {"served": 0, "half": 0, "margin": 0.0, "score": 0.0}
    for k, name in enumerate(args.days):
        raw = load_day(name, args.budget)
        if args.warm:
            plan_in_place = json.loads(Path(args.warm[k]).read_text(encoding="utf-8"))
            raw["initialRoutes"] = [
                {"vehicleId": r["vehicleId"], "stops": [{"tripId": s["tripId"], "kind": s["kind"]} for s in r["stops"]]}
                for r in plan_in_place["routes"]
            ]
        started = time.perf_counter()
        plan = service.optimize(OptimizeRequest.model_validate(raw))
        elapsed = time.perf_counter() - started
        half, broken = half_served(raw, plan)
        score = raw["settings"]["unassignedPenalty"] * (plan.kpis.trips_unassigned + broken) - plan.kpis.margin
        kpis = plan.kpis
        print(
            f"{name}: {kpis.trips_served}/{kpis.trips_total} served, {half} half-served, margin {kpis.margin:.0f}, "
            f"score {score:.0f}, {len(plan.validation.violations)} violation(s), {elapsed:.1f}\u00a0s, {plan.meta.solver_status}",
            flush=True,
        )
        totals["served"] += kpis.trips_served
        totals["half"] += half
        totals["margin"] += kpis.margin
        totals["score"] += score
    print(
        f"total: {totals['served']} served, {totals['half']} half-served, margin {totals['margin']:.0f}, score {totals['score']:.0f}"
    )


if __name__ == "__main__":
    main()
