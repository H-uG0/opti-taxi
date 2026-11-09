"""Estimated revenue of a trip: one invoice per patient, from the grids sent by the web (never hard-coded).

The web picks the grid of each vehicle (`vehicles[].tariffId`: a taxi by the department of its ADS, a VSL
or an ambulance by the company's certification and head office) and, for a seated trip exceptionally
driven by an ambulance, the grid of the trip (`trips[].tariffId`: the VSL grid). contract/README.md
(« Calcul du CA estimé d'une course ») states the rule; this module is its reference implementation, and
the validator recomputes every invoice with its own code (validator.py, REVENUE). The same cases are
checked on both sides of the wire (contract/fixtures/fare-cases.json).

Arithmetic is on integers: amounts in 1/10 000 €, rates in 1/10 000, distances in metres, each input
rounded half up from its shortest decimal writing; the invoice is rounded half up to the cent once, at
the end (never Python's round(), which rounds half to even on binary floats).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from app.schemas import PricingSettings, Tariff, Trip, Vehicle, VehicleType

MONEY_SCALE = 10_000
"""Amounts in 1/10 000 €."""
RATE_SCALE = 10_000
"""Rates in 1/10 000 (0.23 = 2 300)."""
METERS_PER_KM = 1_000
CENTS_PER_EURO = 100
MINUTES_PER_DAY = 24 * 60
SATURDAY, SUNDAY = 6, 7

_CENTS_DENOMINATOR = MONEY_SCALE * METERS_PER_KM * RATE_SCALE**3 // CENTS_PER_EURO
"""What an invoice total (see fare_cents) is divided by to give cents."""


def scaled(value: float, scale: int) -> int:
    """`value` × `scale`, rounded half up from the shortest decimal writing of `value` (>= 0)."""
    return int((Decimal(repr(float(value))) * scale).to_integral_value(rounding=ROUND_HALF_UP))


def meters(km: float) -> int:
    return scaled(km, METERS_PER_KM)


class DayCalendar:
    """Weekday and public holidays of the planned date and the days after it (minutes may pass midnight)."""

    def __init__(self, iso_date: str, holidays: Iterable[str]) -> None:
        self.day = date.fromisoformat(iso_date)
        self.holidays = frozenset(holidays)

    def is_weekend(self, minute: int, saturday_from_min: int) -> bool:
        """Saturday from `saturday_from_min`, Sunday, or a public holiday, at `minute` of the planned day."""
        offset, minute_of_day = divmod(minute, MINUTES_PER_DAY)
        day = self.day + timedelta(days=offset)
        if day.isoformat() in self.holidays:
            return True
        weekday = day.isoweekday()
        return weekday == SUNDAY or (weekday == SATURDAY and minute_of_day >= saturday_from_min)


def night_spans(start_min: int, end_min: int) -> list[tuple[int, int]]:
    """Night time of the planned day and the next one, in minutes of the planned day."""
    if start_min > end_min:  # 20:00 - 08:00: from the evening before to the morning
        return [(day * MINUTES_PER_DAY + start_min - MINUTES_PER_DAY, day * MINUTES_PER_DAY + end_min) for day in range(3)]
    return [(day * MINUTES_PER_DAY + start_min, day * MINUTES_PER_DAY + end_min) for day in range(2)]


def is_night(tariff: Tariff, pickup_min: int, dropoff_min: int) -> bool:
    """More than half of the time from pickup to dropoff falls in the grid's night (all or nothing)."""
    spans = night_spans(tariff.night_start_min, tariff.night_end_min)
    if dropoff_min <= pickup_min:
        return any(start <= pickup_min < end for start, end in spans)
    night = sum(max(0, min(dropoff_min, end) - max(pickup_min, start)) for start, end in spans)
    return 2 * night > dropoff_min - pickup_min


@dataclass(frozen=True)
class Ride:
    """What a patient's invoice reads from the route (the solver estimates it from the time windows)."""

    direct_km: float
    """Road distance pickup -> dropoff."""
    ride_km: float
    """Distance driven with the patient on board."""
    alone_km: float
    """Part of ride_km with nobody else on board."""
    co_passengers: int
    """Distinct patients met on board."""
    max_on_board: int
    """Most patients on board at once during the ride (this one included)."""
    pickup_min: int
    dropoff_min: int
    empty_leg: bool
    """The vehicle drives empty to its station after this dropoff, or came empty from it (settings.pricing.emptyLeg)."""

    @staticmethod
    def alone(direct_km: float, pickup_min: int, dropoff_min: int) -> Ride:
        return Ride(direct_km, direct_km, direct_km, 0, 1, pickup_min, dropoff_min, False)


def patient_count(ride: Ride, rule: str) -> int:
    return max(1, ride.max_on_board) if rule == "MAX_ON_BOARD" else 1 + ride.co_passengers


def billed_meters(tariff: Tariff, ride: Ride) -> int:
    """Direct distance; a shared patient also pays the detour, up to the grid's billable detour."""
    direct = meters(ride.direct_km)
    if ride.co_passengers == 0 or not tariff.billable_detour_km:
        return direct
    cap = sum(meters(km) for km in tariff.billable_detour_km[: ride.co_passengers])
    return direct + min(max(0, meters(ride.ride_km) - direct), cap)


def short_trip_amount(tariff: Tariff, billed_m: int) -> int:
    for band in tariff.short_trip_bands:
        if billed_m <= meters(band.up_to_km):
            return scaled(band.amount, MONEY_SCALE)
    return 0


def surcharge_rate(tariff: Tariff, ride: Ride, calendar: DayCalendar) -> int:
    """Night or weekend/holiday rate, never both: the higher of those that apply."""
    rates = [0]
    if is_night(tariff, ride.pickup_min, ride.dropoff_min):
        rates.append(scaled(tariff.night_rate, RATE_SCALE))
    if calendar.is_weekend(ride.pickup_min, tariff.saturday_from_min):
        rates.append(scaled(tariff.weekend_rate, RATE_SCALE))
    return max(rates)


def discount_rate(tariff: Tariff, ride: Ride, patients: int) -> int:
    if patients < 2:
        return 0
    if tariff.alone_discount > 0 and meters(ride.alone_km) >= meters(tariff.alone_threshold_km):
        return scaled(tariff.alone_discount, RATE_SCALE)
    counted = min(patients, tariff.max_shared_patients)
    applicable = [discount for discount in tariff.shared_discounts if discount.patients <= counted]
    if not applicable:
        return 0
    return scaled(max(applicable, key=lambda discount: discount.patients).rate, RATE_SCALE)


def fare_cents(
    tariff: Tariff,
    trip: Trip,
    vehicle: Vehicle,
    ride: Ride,
    pricing: PricingSettings,
    calendar: DayCalendar,
) -> int:
    """One patient's invoice, in cents (contract/README.md, « Calcul du CA estimé d'une course »)."""
    one = RATE_SCALE
    billed = billed_meters(tariff, ride)
    base = tariff.agglo_fare if trip.agglomeration and tariff.agglo_fare is not None else tariff.base_fare
    fare = scaled(base, MONEY_SCALE) + (scaled(tariff.big_city_fare, MONEY_SCALE) if trip.big_city else 0)
    per_km = scaled(tariff.price_per_km, MONEY_SCALE)
    km = max(0, billed - meters(tariff.included_km))
    short = short_trip_amount(tariff, billed)
    surcharge = surcharge_rate(tariff, ride, calendar)
    empty = 0
    if ride.empty_leg and trip.hospital_linked:
        long_trip = billed >= meters(tariff.empty_leg_threshold_km)
        empty = scaled(tariff.empty_leg_rate_long if long_trip else tariff.empty_leg_rate_short, RATE_SCALE)
    discount = discount_rate(tariff, ride, patient_count(ride, pricing.patient_count))

    # Every term in 1/(MONEY_SCALE x METERS_PER_KM) € and two rate factors.
    fare_term = fare * METERS_PER_KM * one * (one + surcharge)
    if pricing.empty_leg_order == "ADDITIVE":
        km_term = per_km * km * one * (one + empty + surcharge)
    else:
        km_term = per_km * km * (one + empty) * (one + surcharge)
    short_term = short * METERS_PER_KM * one * (one + surcharge if tariff.surcharge_short_trip else one)
    discounted = (fare_term + km_term + short_term) * (one - discount)
    tpmr = scaled(tariff.tpmr_fare, MONEY_SCALE) if trip.wheelchair and vehicle.tpmr_equipped else 0
    outside = (tpmr + scaled(trip.toll_amount, MONEY_SCALE)) * METERS_PER_KM * one**3
    total = discounted + outside
    return (2 * total + _CENTS_DENOMINATOR) // (2 * _CENTS_DENOMINATOR)


class TariffBook:
    """The grids of the request by id, and the one that prices a trip on a vehicle."""

    def __init__(self, tariffs: Iterable[Tariff]) -> None:
        self._grids: dict[str, Tariff] = {tariff.id: tariff for tariff in tariffs}

    def get(self, tariff_id: str | None) -> Tariff | None:
        return None if tariff_id is None else self._grids.get(tariff_id)

    def for_trip(self, trip: Trip, vehicle: Vehicle) -> Tariff | None:
        """The trip's own grid (exceptional ambulance at the VSL tariff), else the vehicle's."""
        return self.get(trip.tariff_id) if trip.tariff_id is not None else self.get(vehicle.tariff_id)

    def missing_warnings(self, vehicles: Sequence[Vehicle]) -> list[str]:
        """One French warning per vehicle type with vehicles the web gave no grid."""
        missing: dict[VehicleType, list[str]] = {}
        for vehicle in vehicles:
            if self.get(vehicle.tariff_id) is None:
                missing.setdefault(vehicle.type, []).append(vehicle.label or vehicle.id)
        return [
            f"Pas de grille tarifaire pour {', '.join(labels)} ({vehicle_type}) : CA estimé à 0"
            for vehicle_type, labels in missing.items()
        ]


def revenue_cents(
    book: TariffBook,
    trip: Trip,
    vehicle: Vehicle,
    ride: Ride,
    pricing: PricingSettings,
    calendar: DayCalendar,
) -> int:
    """Invoice of `trip` on `vehicle` in cents, 0 without a grid."""
    tariff = book.for_trip(trip, vehicle)
    return 0 if tariff is None else fare_cents(tariff, trip, vehicle, ride, pricing, calendar)


def cents_to_euros(cents: int) -> float:
    return cents / CENTS_PER_EURO
