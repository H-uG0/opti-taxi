"""HTTP API of the optimizer (contract v1, see contract/README.md).

Run locally:  .venv/Scripts/python.exe -m uvicorn app.main:app --port 8100
Invalid bodies are rejected with 422 by pydantic. The endpoints are plain `def` functions, so
FastAPI runs the CPU-bound solve in its threadpool without blocking the event loop.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI

from app import service
from app.matrix import configured_osrm_url
from app.schemas import EvaluateRequest, Health, OptimizeRequest, PlanResponse

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "info").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

app = FastAPI(
    title="Opti-Taxi — service d'optimisation",
    version="1.0.0",
    description="Tournées J+1 (OR-Tools, PDPTW) et évaluation de plannings, contrat web <-> optimizer v1.",
)


@app.get("/health")
def health() -> Health:
    """Liveness probe and distance source in use."""
    return Health(status="ok", matrix_source="osrm" if configured_osrm_url() else "haversine")


@app.post("/optimize")
def optimize(request: OptimizeRequest) -> PlanResponse:
    """Compute the routes of a day."""
    return service.optimize(request)


@app.post("/evaluate")
def evaluate(request: EvaluateRequest) -> PlanResponse:
    """Recompute times, km, revenue and violations of a given plan."""
    return service.evaluate(request)
