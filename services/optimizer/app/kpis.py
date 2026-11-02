"""Day indicators of a plan (contract `kpis`), computed from the reported routes and trips."""

from __future__ import annotations

from collections.abc import Sequence

from app.schemas import Kpis, Route, TripResult


def _ratio(numerator: float, denominator: float, digits: int = 4) -> float:
    return round(numerator / denominator, digits) if denominator > 0 else 0.0


def compute_kpis(trips_total: int, routes: Sequence[Route], trips: Sequence[TripResult]) -> Kpis:
    served = [trip for trip in trips if trip.vehicle_id is not None]
    used = [route for route in routes if route.stops]
    total_km = sum(route.distance_km for route in used)
    empty_km = sum(route.empty_km for route in used)
    revenue = sum(trip.revenue for trip in served)
    cost = sum(route.cost for route in used)
    shared = sum(1 for trip in served if trip.shared)
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
        shared_trip_ratio=_ratio(shared, len(served)),
        revenue=round(revenue, 2),
        cost=round(cost, 2),
        margin=round(revenue - cost, 2),
    )
