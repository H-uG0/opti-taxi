"""Everything derived once per request and shared by the solver, the scheduler and the plan builder."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from app.matrix import TravelMatrix
from app.model import TripWindows, derive_windows
from app.pricing import DayCalendar, Ride, TariffBook, revenue_cents
from app.progress import DayProgress, derive_progress
from app.schemas import DayRequest, LatLng, StopKind, Trip, Vehicle
from app.traffic import stop_reference_minute


@dataclass(frozen=True)
class PlanContext:
    request: DayRequest
    matrix: TravelMatrix
    windows: dict[str, TripWindows]
    tariffs: TariffBook
    calendar: DayCalendar
    """Weekday and public holidays of the planned date (night and weekend surcharges)."""
    trips: dict[str, Trip]
    vehicles: dict[str, Vehicle]
    progress: DayProgress
    """A day under way: the stops done, where each vehicle goes on from, the patients on board."""

    def direct_km(self, trip: Trip) -> float:
        """Road distance pickup -> dropoff (billed distance of a patient alone)."""
        return self.matrix.km(trip.pickup, trip.dropoff)

    def estimated_cents(self, trip: Trip, vehicle: Vehicle) -> int:
        """Revenue the solver expects from `trip` on `vehicle` before routing (cents): the patient
        alone on the direct distance, at the trip's reference minutes (night and weekend surcharges);
        plan.py prices the routes found exactly (sharing, detour, empty leg, planned times)."""
        ride = Ride.alone(
            self.direct_km(trip),
            stop_reference_minute(trip, "PICKUP", self.matrix),
            stop_reference_minute(trip, "DROPOFF", self.matrix),
        )
        return revenue_cents(self.tariffs, trip, vehicle, ride, self.request.settings.pricing, self.calendar)


def request_points(request: DayRequest) -> Iterator[LatLng]:
    """Every coordinate the matrix must cover: depots, pickups and dropoffs."""
    for vehicle in request.vehicles:
        yield vehicle.depot
    for trip in request.trips:
        yield trip.pickup
        yield trip.dropoff


def make_context(request: DayRequest, matrix: TravelMatrix) -> PlanContext:
    def first_leg(depot: LatLng, trip: Trip, kind: StopKind) -> int:
        """Minutes from a depot to a stop, as schedule.py times the first leg of a route."""
        place = trip.pickup if kind == "PICKUP" else trip.dropoff
        return matrix.leg(depot, place, None, stop_reference_minute(trip, kind, matrix))

    progress = derive_progress(request, matrix.km, first_leg)
    return PlanContext(
        request=request,
        matrix=matrix,
        windows=derive_windows(request, progress.now_min, progress.is_fixed),
        tariffs=TariffBook(request.tariffs),
        calendar=DayCalendar(request.date, request.settings.pricing.public_holidays),
        trips={trip.id: trip for trip in request.trips},
        vehicles={vehicle.id: vehicle for vehicle in request.vehicles},
        progress=progress,
    )
