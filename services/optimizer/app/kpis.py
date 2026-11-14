"""Day indicators of a plan (contract `kpis`), computed from the reported routes and trips.

The shared rate is the one the Assurance maladie counts (protocol of 24 September 2025) and the
dashboard shows (apps/web/src/lib/kpis-sharing.ts): shared trips among the served eligible trips in a
taxi or a VSL, the transport assis professionnalisé. Eligible (``trips[].sharing_eligible``): the
prescription allows sharing and the caisse pays, a patient's refusal included (a refusal lowers the
rate); neither the ambulances (one lying patient) nor the private clients. A request without the flag
falls back on ``shareable`` (refusals and private clients then read differently). ``shared_trips``
counts every served trip with a co-passenger.
"""

from __future__ import annotations

from collections.abc import Sequence

from app.schemas import DayRequest, Kpis, Route, Trip, TripResult

TAP_TYPES = frozenset({"TAXI", "VSL"})


def _ratio(numerator: float, denominator: float, digits: int = 4) -> float:
    return round(numerator / denominator, digits) if denominator > 0 else 0.0


def _sharing_eligible(trip: Trip) -> bool:
    return trip.sharing_eligible if trip.sharing_eligible is not None else trip.shareable


def compute_kpis(request: DayRequest, routes: Sequence[Route], trips: Sequence[TripResult]) -> Kpis:
    trips_total = len(request.trips)
    eligible = {trip.id for trip in request.trips if _sharing_eligible(trip)}
    vehicle_types = {vehicle.id: vehicle.type for vehicle in request.vehicles}
    served = [trip for trip in trips if trip.vehicle_id is not None]
    used = [route for route in routes if route.stops]
    total_km = sum(route.distance_km for route in used)
    empty_km = sum(route.empty_km for route in used)
    revenue = sum(trip.revenue for trip in served)
    cost = sum(route.cost for route in used)
    shared = sum(1 for trip in served if trip.shared)
    in_scope = [trip for trip in served if trip.trip_id in eligible and vehicle_types.get(trip.vehicle_id or "") in TAP_TYPES]
    return Kpis(
        trips_total=trips_total,
        trips_served=len(served),
        trips_unassigned=trips_total - len(served),
        vehicles_used=len(used),
        trips_per_vehicle=_ratio(len(served), len(used), 2),
        total_km=round(total_km, 2),
        empty_km=round(empty_km, 2),
        empty_km_ratio=_ratio(empty_km, total_km),
        shared_trips=shared,
        shareable_trips=len(in_scope),
        shared_trip_ratio=_ratio(sum(1 for trip in in_scope if trip.shared), len(in_scope)),
        revenue=round(revenue, 2),
        cost=round(cost, 2),
        margin=round(revenue - cost, 2),
    )
