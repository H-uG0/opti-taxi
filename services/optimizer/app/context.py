"""Everything derived once per request and shared by the solver, the scheduler and the plan builder."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from app.matrix import TravelMatrix
from app.model import TripWindows, derive_windows
from app.pricing import TariffBook
from app.schemas import DayRequest, LatLng, Trip, Vehicle


@dataclass(frozen=True)
class PlanContext:
    request: DayRequest
    matrix: TravelMatrix
    windows: dict[str, TripWindows]
    tariffs: TariffBook
    trips: dict[str, Trip]
    vehicles: dict[str, Vehicle]

    def direct_km(self, trip: Trip) -> float:
        """Road distance pickup -> dropoff (basis of the revenue)."""
        return self.matrix.km(trip.pickup, trip.dropoff)


def request_points(request: DayRequest) -> Iterator[LatLng]:
    """Every coordinate the matrix must cover: depots, pickups and dropoffs."""
    for vehicle in request.vehicles:
        yield vehicle.depot
    for trip in request.trips:
        yield trip.pickup
        yield trip.dropoff


def make_context(request: DayRequest, matrix: TravelMatrix) -> PlanContext:
    return PlanContext(
        request=request,
        matrix=matrix,
        windows=derive_windows(request),
        tariffs=TariffBook(request.tariffs),
        trips={trip.id: trip for trip in request.trips},
        vehicles={vehicle.id: vehicle for vehicle in request.vehicles},
    )
