"""Day indicators of a plan: the shared rate counts as the Assurance maladie does."""

from __future__ import annotations

from app.kpis import compute_kpis
from app.schemas import EvaluateRequest, TripResult
from tests.builders import load_fixture


def _result(trip_id: str, vehicle_id: str | None, shared: bool = False) -> TripResult:
    return TripResult(
        trip_id=trip_id,
        vehicle_id=vehicle_id,
        pickup_min=None,
        dropoff_min=None,
        shared=shared,
        co_passenger_trip_ids=[],
        direct_km=0,
        ride_km=0,
        detour_km=0,
        revenue=10,
        wait_at_facility_min=None,
    )


def test_shared_rate_counts_shareable_trips_in_a_taxi_or_a_vsl_only() -> None:
    # The fixture: trips 1 to 4 shareable and seated, 5 and 6 lying (ambulance), 7 seated but not shareable.
    request = EvaluateRequest.model_validate(load_fixture("evaluate-request.json"))
    trips = [
        _result("trip_1", "veh_taxi_1", shared=True),
        _result("trip_3", "veh_taxi_1", shared=True),
        _result("trip_2", "veh_vsl_1"),
        _result("trip_4", None),
        _result("trip_5", "veh_amb_1"),
        _result("trip_6", "veh_amb_1"),
        _result("trip_7", "veh_vsl_1"),
    ]
    kpis = compute_kpis(request, [], trips)
    assert kpis.trips_served == 6 and kpis.trips_unassigned == 1
    assert kpis.shared_trips == 2
    # Shareable and served in a taxi or a VSL: trips 1, 2 and 3. Not the ambulances nor trip 7.
    assert kpis.shareable_trips == 3
    assert kpis.shared_trip_ratio == round(2 / 3, 4)


def test_shared_rate_is_zero_without_shareable_trips() -> None:
    request = EvaluateRequest.model_validate(load_fixture("evaluate-request.json"))
    kpis = compute_kpis(request, [], [_result("trip_5", "veh_amb_1")])
    assert kpis.shareable_trips == 0 and kpis.shared_trip_ratio == 0.0
