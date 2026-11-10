"""HTTP API of the optimizer (contract v1, see contract/README.md).

Run locally:  .venv/Scripts/python.exe -m uvicorn app.main:app --port 8100
Invalid bodies are rejected with 422 by pydantic. The endpoints are plain `def` functions, so
FastAPI runs the CPU-bound solve in its threadpool without blocking the event loop.
Protections (app/security.py): bearer token when OPTIMIZER_TOKEN is set (401, checked before the
body is read, on every path but /health, /docs included), at most OPTIMIZER_MAX_CONCURRENT_SOLVES
solves at once (429), request bodies bounded (413).
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import service
from app.matrix import configured_osrm_url
from app.schemas import EvaluateRequest, Health, InsertRequest, InsertResponse, OptimizeRequest, PlanResponse
from app.security import BodySizeLimit, RequireToken, SolveSlots, log_startup_settings, max_concurrent_solves

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "info").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

solve_slots = SolveSlots(max_concurrent_solves())


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    log_startup_settings(solve_slots)
    yield


app = FastAPI(
    title="Opti-Taxi — service d'optimisation",
    version="1.0.0",
    description="Tournées J+1 (OR-Tools, PDPTW), évaluation de plannings et place d'une course, contrat web <-> optimizer v1.",
    lifespan=lifespan,
)
app.add_middleware(BodySizeLimit)
# Added last, so it runs first: a caller without the token gets 401 before anything else.
app.add_middleware(RequireToken)


@app.get("/health")
def health() -> Health:
    """Liveness probe and distance source in use. Open: no token required."""
    return Health(status="ok", matrix_source="osrm" if configured_osrm_url() else "haversine")


@app.post("/optimize")
def optimize(request: OptimizeRequest) -> PlanResponse:
    """Compute the routes of a day (429 while OPTIMIZER_MAX_CONCURRENT_SOLVES solves run)."""
    with solve_slots.hold():
        return service.optimize(request)


@app.post("/evaluate")
def evaluate(request: EvaluateRequest) -> PlanResponse:
    """Recompute times, km, revenue and violations of a given plan (no solver: not counted as a solve)."""
    return service.evaluate(request)


@app.post("/insert")
def insert(request: InsertRequest) -> InsertResponse:
    """Best place of one trip in each vehicle's route in place, routes kept (no solver: not counted as a solve)."""
    return service.insert(request)
