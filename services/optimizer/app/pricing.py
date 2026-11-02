"""Estimated revenue of a trip, from the tariff grids sent by the web app (never hard-coded).

Grid lookup: (vehicle type, vehicle department), then (vehicle type, "*").
Revenue: `baseFare + pricePerKm * max(0, directKm - includedKm)`, reduced by the shared-transport
discount when the patient rides with co-passengers (n = 1 + distinct co-passengers, capped at 3).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from app.schemas import Tariff, Vehicle, VehicleType

ANY_DEPARTMENT = "*"
MAX_SHARED_PATIENTS = 3


class TariffBook:
    """Tariff grids indexed by (vehicle type, department) with the "*" fallback."""

    def __init__(self, tariffs: Iterable[Tariff]) -> None:
        self._grids: dict[tuple[VehicleType, str], Tariff] = {}
        for tariff in tariffs:
            # First grid wins when the web sends duplicates.
            self._grids.setdefault((tariff.vehicle_type, tariff.department), tariff)

    def find(self, vehicle_type: VehicleType, department: str) -> Tariff | None:
        return self._grids.get((vehicle_type, department)) or self._grids.get((vehicle_type, ANY_DEPARTMENT))

    def for_vehicle(self, vehicle: Vehicle) -> Tariff | None:
        return self.find(vehicle.type, vehicle.department)

    def missing_warnings(self, vehicles: Sequence[Vehicle]) -> list[str]:
        """One French warning per (type, department) of the fleet without any grid."""
        warnings: list[str] = []
        seen: set[tuple[VehicleType, str]] = set()
        for vehicle in vehicles:
            key = (vehicle.type, vehicle.department)
            if key in seen or self.find(*key) is not None:
                continue
            seen.add(key)
            warnings.append(f"Pas de grille tarifaire pour {vehicle.type}/{vehicle.department} : CA estimé à 0")
        return warnings


def base_revenue(tariff: Tariff | None, direct_km: float) -> float:
    """Undiscounted revenue of one patient transported on `direct_km` (0 without a grid)."""
    if tariff is None:
        return 0.0
    return tariff.base_fare + tariff.price_per_km * max(0.0, direct_km - tariff.included_km)


def shared_discount(tariff: Tariff, patients: int) -> float:
    """Discount rate for a ride shared by `patients` distinct patients (1 = not shared)."""
    n = min(patients, MAX_SHARED_PATIENTS)
    if n >= 3:
        return tariff.shared_discount3
    if n == 2:
        return tariff.shared_discount2
    return 0.0


def trip_revenue(tariff: Tariff | None, direct_km: float, patients: int = 1) -> float:
    """Revenue of a trip whose patient rode with `patients - 1` distinct co-passengers."""
    if tariff is None:
        return 0.0
    return base_revenue(tariff, direct_km) * (1.0 - shared_discount(tariff, patients))
