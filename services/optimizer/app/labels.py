"""French wording helpers for messages shown to the regulator (warnings, reasons, violations)."""

from __future__ import annotations

from collections.abc import Iterable

from app.schemas import Vehicle, VehicleType

VEHICLE_TYPE_LABELS: dict[VehicleType, str] = {"TAXI": "Taxi", "VSL": "VSL", "AMBULANCE": "Ambulance"}


def hhmm(minute: int) -> str:
    """Minutes since midnight as HH:MM (hours above 23 mean the next day)."""
    sign = "-" if minute < 0 else ""
    minute = abs(minute)
    return f"{sign}{minute // 60:02d}:{minute % 60:02d}"


def km_text(value: float) -> str:
    """Kilometres with one decimal and a French decimal comma."""
    return f"{value:.1f}".replace(".", ",") + "\u00a0km"


def types_text(types: Iterable[VehicleType]) -> str:
    return ", ".join(VEHICLE_TYPE_LABELS[t] for t in types)


def vehicle_name(vehicle: Vehicle) -> str:
    return f"«\u202f{vehicle.label or vehicle.id}\u202f»"
