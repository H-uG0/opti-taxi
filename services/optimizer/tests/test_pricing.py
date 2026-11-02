"""Revenue estimate from the tariff grids: lookup with "*" fallback and sharing discounts."""

from __future__ import annotations

import pytest

from app.pricing import TariffBook, base_revenue, shared_discount, trip_revenue
from app.schemas import Tariff, Vehicle
from tests.builders import MARSEILLE, vehicle


def grid(vehicle_type: str, department: str, base: float = 13.0, per_km: float = 1.12, included: float = 0.0) -> Tariff:
    return Tariff.model_validate(
        {
            "vehicleType": vehicle_type,
            "department": department,
            "baseFare": base,
            "pricePerKm": per_km,
            "includedKm": included,
            "sharedDiscount2": 0.23,
            "sharedDiscount3": 0.35,
        }
    )


def test_exact_department_wins_over_wildcard() -> None:
    book = TariffBook([grid("TAXI", "*", per_km=1.0), grid("TAXI", "13", per_km=1.12)])
    found = book.find("TAXI", "13")
    assert found is not None and found.price_per_km == 1.12


def test_wildcard_department_is_the_fallback() -> None:
    book = TariffBook([grid("TAXI", "13"), grid("VSL", "*", base=13.6, per_km=1.0)])
    found = book.find("VSL", "05")
    assert found is not None and found.base_fare == 13.6
    assert book.find("TAXI", "05") is None


def test_missing_grid_gives_zero_revenue_and_a_warning() -> None:
    book = TariffBook([grid("TAXI", "13")])
    ambulance = Vehicle.model_validate(vehicle("amb", MARSEILLE, type_="AMBULANCE", department="05"))
    assert book.for_vehicle(ambulance) is None
    assert trip_revenue(None, 50.0, 1) == 0.0
    warnings = book.missing_warnings([ambulance, ambulance])
    assert warnings == ["Pas de grille tarifaire pour AMBULANCE/05 : CA estimé à 0"]


def test_base_revenue_with_included_km() -> None:
    assert base_revenue(grid("TAXI", "13"), 10.0) == pytest.approx(13 + 11.2)
    ambulance = grid("AMBULANCE", "*", base=64.5, per_km=2.4, included=3)
    assert base_revenue(ambulance, 2.0) == pytest.approx(64.5)
    assert base_revenue(ambulance, 13.0) == pytest.approx(64.5 + 24.0)


@pytest.mark.parametrize(("patients", "discount"), [(1, 0.0), (2, 0.23), (3, 0.35), (5, 0.35)])
def test_sharing_discount_by_number_of_patients(patients: int, discount: float) -> None:
    tariff = grid("TAXI", "13")
    assert shared_discount(tariff, patients) == discount
    assert trip_revenue(tariff, 10.0, patients) == pytest.approx(24.2 * (1 - discount))
