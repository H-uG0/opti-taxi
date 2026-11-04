"""Traffic: time-band tables, reference minutes, and one travel time shared by solver and validator."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.matrix import TravelMatrix, haversine_matrix
from app.schemas import LatLng, TrafficSettings
from app.service import evaluate, optimize
from app.traffic import ZoneFactors, _km_inside, stop_reference_minute, with_traffic
from tests.builders import GAP, MARSEILLE, Json, Point, evaluate_request, generated_day, latlng, offset, optimize_request, request, trip, vehicle

NEARBY: Point = (43.3200, 5.4000)  # about 3.7 km from the center of Marseille
FACILITY: Point = (43.2700, 5.3900)  # about 3.4 km the other way
FAR: Point = (44.9000, 5.9000)  # far from Marseille, between Gap and Grenoble


def traffic_json(zone_factors: tuple[float, float] = (1.5, 1.2), road: tuple[float, float] = (1.0, 1.0)) -> Json:
    return {
        "bands": [{"startMin": 420, "endMin": 570}, {"startMin": 570, "endMin": 960}],
        "roadFactors": list(road),
        "zones": [{**latlng(MARSEILLE), "radiusKm": 14, "factors": list(zone_factors)}],
    }


def traffic(zone_factors: tuple[float, float] = (1.5, 1.2), road: tuple[float, float] = (1.0, 1.0)) -> TrafficSettings:
    return TrafficSettings.model_validate(traffic_json(zone_factors, road))


def ll(point: Point) -> LatLng:
    return LatLng(lat=point[0], lng=point[1])


def matrix_of(*points: Point) -> TravelMatrix:
    return haversine_matrix(list(points))


def outbound_at(appointment: int, **overrides: Any) -> Json:
    return trip("t1", "p1", "OUTBOUND", NEARBY, FACILITY, appointment=appointment, **overrides)


class TestZoneGeometry:
    def test_length_inside_the_circle(self) -> None:
        zone = traffic().zones[0]
        # From the center straight out: exactly one radius lies inside.
        assert _km_inside(MARSEILLE, GAP, zone) == pytest.approx(14, abs=0.01)
        # Both ends inside: the whole segment.
        assert _km_inside(MARSEILLE, NEARBY, zone) == pytest.approx(3.7, abs=0.3)
        # Across the circle: its diameter.
        west, east = (MARSEILLE[0], MARSEILLE[1] - 1), (MARSEILLE[0], MARSEILLE[1] + 1)
        assert _km_inside(west, east, zone) == pytest.approx(28, abs=0.01)
        # Far from the circle, and a point to itself.
        assert _km_inside(GAP, FAR, zone) == 0
        assert _km_inside(MARSEILLE, MARSEILLE, zone) == 0


class TestZoneFactors:
    def test_a_leg_inside_the_zone_takes_the_zone_factor(self) -> None:
        matrix = matrix_of(MARSEILLE, NEARBY)
        base = matrix.minutes_table[0][1]
        peak, day = ZoneFactors().tables(matrix, traffic())
        assert peak[0][1] == pytest.approx(base * 1.5, abs=1)
        assert day[0][1] == pytest.approx(base * 1.2, abs=1)
        assert peak[0][0] == 0

    def test_a_long_leg_is_slowed_only_on_the_part_inside_the_zone(self) -> None:
        matrix = matrix_of(MARSEILLE, GAP)
        base = matrix.minutes_table[0][1]
        peak, _ = ZoneFactors().tables(matrix, traffic())
        # 14 km x 1.3 at 30 km/h = 36.4 min inside the zone, x 0.5.
        assert peak[0][1] == pytest.approx(base + 18.2, abs=1)

    def test_the_road_factor_applies_outside_the_zones(self) -> None:
        matrix = matrix_of(GAP, FAR)
        base = matrix.minutes_table[0][1]
        peak, day = ZoneFactors().tables(matrix, traffic(road=(1.1, 1.0)))
        assert peak[0][1] == pytest.approx(base * 1.1, abs=1)
        assert day[0][1] == base

    def test_factors_of_one_change_nothing(self) -> None:
        matrix = matrix_of(MARSEILLE, NEARBY, GAP)
        peak, day = ZoneFactors().tables(matrix, traffic((1.0, 1.0)))
        assert peak == matrix.minutes_table
        assert day == matrix.minutes_table


class TestLegReference:
    def test_a_leg_takes_the_slower_band_of_its_two_ends_and_free_flow_outside_the_bands(self) -> None:
        matrix = with_traffic(matrix_of(MARSEILLE, NEARBY), traffic())
        a, b = ll(MARSEILLE), ll(NEARBY)
        base = matrix.minutes(a, b)
        assert matrix.leg(a, b, 450, 900) == matrix.leg(a, b, 900, 450) > matrix.leg(a, b, 600, 900) > base
        assert matrix.leg(a, b, 300, 1200) == base
        assert matrix.leg(a, b, 300, 450) == matrix.leg(a, b, 450, 450)
        assert matrix.traffic_source == "factors"

    def test_a_long_leg_starting_before_the_peak_drives_through_it(self) -> None:
        matrix = with_traffic(matrix_of(GAP, MARSEILLE), traffic())
        a, b = ll(GAP), ll(MARSEILLE)
        appointment = 540
        reference = appointment - matrix.minutes(a, b)
        assert reference < 420  # before the morning peak...
        assert matrix.leg(a, b, reference, appointment) == matrix.leg(a, b, appointment, appointment) > matrix.minutes(a, b)  # ...but not its end

    def test_a_leg_from_or_to_the_depot_guesses_the_missing_end_from_the_free_flow_drive(self) -> None:
        matrix = with_traffic(matrix_of(MARSEILLE, NEARBY), traffic())
        a, b = ll(MARSEILLE), ll(NEARBY)
        base = matrix.minutes(a, b)
        assert matrix.leg(a, b, None, 450) == matrix.leg(a, b, 450, None) == matrix.leg(a, b, 450, 450)
        # Only the guessed end falls in the band.
        assert matrix.leg(a, b, None, 420 - 1) == base
        assert matrix.leg(a, b, 420 - base, None) == matrix.leg(a, b, 450, 450)
        assert matrix.leg(a, b, None, None) == base

    def test_without_traffic_every_leg_is_free_flow(self) -> None:
        matrix = matrix_of(MARSEILLE, NEARBY)
        a, b = ll(MARSEILLE), ll(NEARBY)
        assert with_traffic(matrix, None) is matrix
        assert matrix.traffic_source == "none"
        assert matrix.leg(a, b, 450, 450) == matrix.minutes(a, b)

    def test_reference_minutes_come_from_the_appointment_and_the_end_of_session(self) -> None:
        matrix = matrix_of(MARSEILLE, NEARBY)
        ride = matrix.minutes(ll(MARSEILLE), ll(NEARBY))
        raw = request(
            [vehicle("v1", MARSEILLE)],
            [
                trip("out", "p1", "OUTBOUND", MARSEILLE, NEARBY, appointment=480),
                trip("back", "p1", "RETURN", NEARBY, MARSEILLE, ready=700),
            ],
        )
        outbound, back = optimize_request(raw).trips
        assert stop_reference_minute(outbound, "DROPOFF", matrix) == 480
        assert stop_reference_minute(outbound, "PICKUP", matrix) == 480 - ride
        assert stop_reference_minute(back, "PICKUP", matrix) == 700
        assert stop_reference_minute(back, "DROPOFF", matrix) == 700 + ride


class TestContract:
    def test_bands_must_be_sorted_without_overlap(self) -> None:
        with pytest.raises(ValidationError, match="must not overlap"):
            TrafficSettings.model_validate(
                {"bands": [{"startMin": 420, "endMin": 570}, {"startMin": 500, "endMin": 960}], "roadFactors": [1, 1], "zones": []}
            )

    def test_one_factor_per_band_is_required(self) -> None:
        with pytest.raises(ValidationError, match="one traffic factor per band"):
            TrafficSettings.model_validate({"bands": [{"startMin": 420, "endMin": 570}], "roadFactors": [1, 1], "zones": []})
        with pytest.raises(ValidationError, match="one traffic factor per band"):
            TrafficSettings.model_validate(
                {
                    "bands": [{"startMin": 420, "endMin": 570}],
                    "roadFactors": [1],
                    "zones": [{**latlng(MARSEILLE), "radiusKm": 10, "factors": [1.5, 1.2]}],
                }
            )

    def test_a_factor_cannot_make_traffic_faster_than_free_flow(self) -> None:
        with pytest.raises(ValidationError):
            TrafficSettings.model_validate({"bands": [{"startMin": 420, "endMin": 570}], "roadFactors": [0.9], "zones": []})


class TestPlans:
    def test_the_plan_leaves_earlier_in_the_morning_peak_and_stays_valid(self) -> None:
        raw = request([vehicle("v1", MARSEILLE)], [outbound_at(480)])
        free = optimize(optimize_request(raw))
        slowed = optimize(optimize_request({**raw, "settings": {**raw["settings"], "traffic": traffic_json((3.0, 1.2))}}))
        assert free.meta.traffic_source == "none"
        assert slowed.meta.traffic_source == "factors"
        assert free.validation.valid and slowed.validation.valid
        assert free.kpis.trips_served == slowed.kpis.trips_served == 1

        def ride(plan: Any) -> int:
            pickup, dropoff = plan.routes[0].stops
            return dropoff.arrival_min - pickup.departure_min

        assert ride(slowed) > ride(free)
        assert slowed.routes[0].stops[0].start_min < free.routes[0].stops[0].start_min
        # Traffic changes times, never kilometers.
        assert slowed.kpis.total_km == free.kpis.total_km

    def test_a_trip_reachable_in_free_flow_may_not_be_in_the_peak(self) -> None:
        matrix = matrix_of(MARSEILLE, NEARBY, FACILITY)
        # The shift starts just early enough for the free-flow drive to the appointment.
        drive = matrix.minutes_table[0][1] + 5 + matrix.minutes_table[1][2]
        raw = request([vehicle("v1", MARSEILLE, shift=(480 - drive, 1140))], [outbound_at(480)])
        assert optimize(optimize_request(raw)).kpis.trips_served == 1
        result = optimize(optimize_request({**raw, "settings": {**raw["settings"], "traffic": traffic_json((3.0, 1.2))}}))
        assert result.kpis.trips_served == 0
        assert result.validation.valid

    def test_evaluate_times_the_plan_like_optimize(self) -> None:
        raw = request([vehicle("v1", MARSEILLE)], [outbound_at(480)], traffic=traffic_json((3.0, 1.2)))
        plan = optimize(optimize_request(raw))
        routes = {r.vehicle_id: [(s.trip_id, s.kind) for s in r.stops] for r in plan.routes}
        again = evaluate(evaluate_request(raw, routes))
        assert again.validation.valid
        assert again.routes[0].stops == plan.routes[0].stops
        assert again.meta.traffic_source == "factors"

    @pytest.mark.parametrize("second_appointment", range(636, 652, 2))
    def test_a_break_window_across_a_band_edge_leaves_a_valid_plan(self, second_appointment: int) -> None:
        """The model times the drive leaving the break in the break's band, the schedule times the
        whole leg in the band of the stop before it: they must not disagree on what fits."""
        zones = {
            "bands": [{"startMin": 420, "endMin": 570}, {"startMin": 570, "endMin": 960}, {"startMin": 960, "endMin": 1140}],
            "roadFactors": [1.05, 1.0, 1.05],
            "zones": [{**latlng(MARSEILLE), "radiusKm": 14, "factors": [1.5, 1.2, 1.5]}],
        }
        home_a, facility_a = offset(MARSEILLE, 1, 1), offset(MARSEILLE, -6, 0)
        home_b, facility_b = offset(MARSEILLE, 9, 0), offset(MARSEILLE, 9, 3)
        raw = request(
            [vehicle("v1", MARSEILLE, shift=(360, 1140), break_={"windowStartMin": 540, "windowEndMin": 660, "durationMin": 45})],
            [
                trip("A", "p1", "OUTBOUND", home_a, facility_a, appointment=569, shareable=False),
                trip("B", "p2", "OUTBOUND", home_b, facility_b, appointment=second_appointment, shareable=False),
            ],
            traffic=zones,
        )
        result = optimize(optimize_request(raw))
        assert result.validation.valid, result.validation.violations

    def test_a_full_day_in_heavy_traffic_passes_the_independent_validator(self) -> None:
        raw = generated_day(time_limit_sec=3)
        heavy = {
            "bands": [{"startMin": 420, "endMin": 570}, {"startMin": 570, "endMin": 960}, {"startMin": 960, "endMin": 1140}],
            "roadFactors": [1.2, 1.05, 1.2],
            "zones": [
                {**latlng(MARSEILLE), "radiusKm": 14, "factors": [2.0, 1.3, 2.0]},
                {"lat": 45.1885, "lng": 5.7245, "radiusKm": 10, "factors": [1.8, 1.2, 1.8]},
            ],
        }
        result = optimize(optimize_request({**raw, "settings": {**raw["settings"], "traffic": heavy}}))
        assert result.validation.valid, result.validation.violations
        assert result.kpis.trips_served > 0
