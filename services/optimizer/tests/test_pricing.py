"""Revenue of a patient's invoice: the reference cases of contract/fixtures/fare-cases.json (also run by
the web), recomputed by pricing.py and by the validator's own code; grid selection and warnings."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app import validator
from app.pricing import DayCalendar, Ride, TariffBook, fare_cents, is_night, scaled
from app.schemas import DayRequest, PricingSettings, Tariff, Trip, Vehicle
from tests.builders import MARSEILLE, request, settings, trip, vehicle

HOME_A = (43.31, 5.40)
AIX_FAC = (43.526, 5.438)

FARE_CASES = json.loads((Path(__file__).resolve().parents[3] / "contract" / "fixtures" / "fare-cases.json").read_text("utf-8"))
GRIDS = {grid["id"]: Tariff.model_validate(grid) for grid in FARE_CASES["grids"]}
DEFAULTS = FARE_CASES["defaults"]


def _case_parts(case: dict[str, Any]) -> tuple[Tariff, Trip, Vehicle, Ride, PricingSettings, DayCalendar]:
    raw_trip = {**trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600), **DEFAULTS["trip"], **case.get("trip", {})}
    raw_vehicle = {**vehicle("v", MARSEILLE), **DEFAULTS["vehicle"], **case.get("vehicle", {})}
    pricing = PricingSettings.model_validate({**DEFAULTS["pricing"], **case.get("pricing", {})})
    r = case["ride"]
    ride = Ride(r["directKm"], r["rideKm"], r["aloneKm"], r["coPassengers"], r["maxOnBoard"], r["pickupMin"], r["dropoffMin"], r["emptyLeg"])
    calendar = DayCalendar(case["date"], case["publicHolidays"])
    return GRIDS[case["grid"]], Trip.model_validate(raw_trip), Vehicle.model_validate(raw_vehicle), ride, pricing, calendar


@pytest.mark.parametrize("case", FARE_CASES["cases"], ids=[case["name"] for case in FARE_CASES["cases"]])
def test_reference_invoice(case: dict[str, Any]) -> None:
    tariff, trip_, vehicle_, ride, pricing, calendar = _case_parts(case)
    assert fare_cents(tariff, trip_, vehicle_, ride, pricing, calendar) == scaled(case["expected"], 100)


@pytest.mark.parametrize("case", FARE_CASES["cases"], ids=[case["name"] for case in FARE_CASES["cases"]])
def test_validator_recomputes_the_same_invoice(case: dict[str, Any]) -> None:
    tariff, trip_, vehicle_, ride, pricing, calendar = _case_parts(case)
    raw = request([vehicle("v", MARSEILLE)], [trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600)])
    raw["date"] = case["date"]
    raw["settings"] = settings(pricing={**pricing.model_dump(by_alias=True), "publicHolidays": case["publicHolidays"]})
    day = DayRequest.model_validate(raw)
    served = validator._Served(
        trip=trip_,
        vehicle=vehicle_,
        route_no=0,
        first_stop=ride.empty_leg and trip_.direction == "RETURN",
        last_stop=ride.empty_leg and trip_.direction == "OUTBOUND",
        pickup_min=ride.pickup_min,
        dropoff_min=ride.dropoff_min,
        ride_km=ride.ride_km,
        alone_km=ride.alone_km,
        others=frozenset(f"other_{k}" for k in range(ride.co_passengers)),
        most_on_board=ride.max_on_board,
    )
    invoice = validator._invoice(day, tariff, served, ride.direct_km, frozenset(case["publicHolidays"]))
    assert float(invoice) == case["expected"]


def test_half_up_rounding_never_banker_rounding() -> None:
    # 27.59 x 1.5 = 41.385: round() on the binary float gives 41.38.
    assert round(27.59 * 1.5, 2) == 41.38
    tariff = GRIDS["vsl_certified"]
    tariff_trip = Trip.model_validate(trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600))
    taxi = Vehicle.model_validate(vehicle("v", MARSEILLE))
    night = Ride.alone(6.0, 1260, 1280)
    assert fare_cents(tariff, tariff_trip, taxi, night, PricingSettings(), DayCalendar("2026-11-10", [])) == 4139


@pytest.mark.parametrize(
    ("pickup", "dropoff", "night"),
    [(1199, 1199, False), (1200, 1200, True), (465, 490, True), (465, 500, False), (1500, 1560, True), (1950, 2000, False)],
)
def test_night_is_more_than_half_of_the_time_on_board(pickup: int, dropoff: int, night: bool) -> None:
    assert is_night(GRIDS["taxi_13"], pickup, dropoff) is night


def test_weekend_of_a_minute_past_midnight_is_read_on_the_next_day() -> None:
    friday = DayCalendar("2026-11-13", [])
    assert not friday.is_weekend(1430, 720)
    assert not friday.is_weekend(1440 + 600, 720)  # Saturday 10:00
    assert friday.is_weekend(1440 + 720, 720)  # Saturday 12:00
    assert DayCalendar("2026-11-10", ["2026-11-11"]).is_weekend(1440 + 60, 720)  # holiday after midnight


def test_grid_of_the_trip_wins_over_the_grid_of_the_vehicle() -> None:
    book = TariffBook(GRIDS.values())
    ambulance = Vehicle.model_validate(vehicle("amb", MARSEILLE, type_="AMBULANCE", tariff_id="ambulance_certified"))
    seated = Trip.model_validate(trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600))
    exceptional = seated.model_copy(update={"tariff_id": "vsl_certified"})
    found = book.for_trip(seated, ambulance)
    assert found is not None and found.id == "ambulance_certified"
    found = book.for_trip(exceptional, ambulance)
    assert found is not None and found.id == "vsl_certified"


def test_vehicle_without_grid_earns_nothing_and_is_reported() -> None:
    book = TariffBook(GRIDS.values())
    raw = vehicle("amb_gap", MARSEILLE, type_="AMBULANCE", tariff_id=None)
    lone = Vehicle.model_validate(raw)
    other = Vehicle.model_validate({**raw, "id": "amb_2", "label": "Amb 2"})
    assert book.for_trip(Trip.model_validate(trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600)), lone) is None
    assert book.missing_warnings([lone, other]) == ["Pas de grille tarifaire pour Amb Gap, Amb 2 (AMBULANCE)\u00a0: CA estimé à 0"]


def test_unknown_tariff_reference_is_refused() -> None:
    raw = request([vehicle("v", MARSEILLE, tariff_id="nope")], [])
    with pytest.raises(ValueError, match="unknown tariff id"):
        DayRequest.model_validate(raw)


def test_short_trip_bands_must_be_sorted() -> None:
    with pytest.raises(ValueError, match="shortTripBands"):
        Tariff.model_validate({**FARE_CASES["grids"][3], "shortTripBands": [{"upToKm": 8, "amount": 1}, {"upToKm": 7, "amount": 2}]})
