"""Request builders for the tests (camelCase dicts, as the web app sends them)."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

from app.schemas import EvaluateRequest, OptimizeRequest

FIXTURES = Path(__file__).resolve().parents[3] / "contract" / "fixtures"

Json = dict[str, Any]
Point = tuple[float, float]

MARSEILLE: Point = (43.2965, 5.3698)
AIX: Point = (43.5297, 5.4474)
MANOSQUE: Point = (43.8342, 5.7839)
SISTERON: Point = (44.1955, 5.9436)
GAP: Point = (44.5594, 6.0786)
GRENOBLE: Point = (45.1885, 5.7245)

STANDARD_BREAK: Json = {"windowStartMin": 690, "windowEndMin": 840, "durationMin": 45}


def load_fixture(name: str) -> Json:
    data: Json = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return data


def latlng(point: Point) -> Json:
    return {"lat": point[0], "lng": point[1]}


def settings(**overrides: Any) -> Json:
    base: Json = {
        "waitBeforeAppointmentMin": 30,
        "waitAfterSessionMin": 15,
        "maxTotalWaitMin": 45,
        "maxDetourKmPerExtraPatient": 10,
        "maxDetourKmTotal": 30,
        "pickupServiceMin": 5,
        "dropoffServiceMin": 5,
        "unassignedPenalty": 10000,
        "timeLimitSec": 1,
    }
    base.update(overrides)
    return base


def vehicle(
    vehicle_id: str,
    depot: Point,
    *,
    type_: str = "TAXI",
    capacity: int | None = None,
    department: str = "13",
    shift: tuple[int, int] = (360, 1140),
    break_: Json | None = None,
    cost_per_km: float | None = None,
    cost_per_hour: float | None = None,
) -> Json:
    defaults = {"TAXI": (2, 0.32, 24.0), "VSL": (2, 0.30, 23.0), "AMBULANCE": (1, 0.42, 46.0)}[type_]
    return {
        "id": vehicle_id,
        "label": vehicle_id.replace("_", " ").title(),
        "type": type_,
        "capacity": capacity if capacity is not None else defaults[0],
        "depot": latlng(depot),
        "department": department,
        "costPerKm": cost_per_km if cost_per_km is not None else defaults[1],
        "costPerHour": cost_per_hour if cost_per_hour is not None else defaults[2],
        "shiftStartMin": shift[0],
        "shiftEndMin": shift[1],
        "break": break_,
    }


def trip(
    trip_id: str,
    patient_id: str,
    direction: str,
    pickup: Point,
    dropoff: Point,
    *,
    appointment: int | None = None,
    ready: int | None = None,
    types: tuple[str, ...] = ("TAXI", "VSL"),
    shareable: bool = True,
    locked: str | None = None,
    facility: str | None = "fac",
) -> Json:
    return {
        "id": trip_id,
        "patientId": patient_id,
        "facilityId": facility,
        "direction": direction,
        "pickup": latlng(pickup),
        "dropoff": latlng(dropoff),
        "appointmentMin": appointment,
        "readyMin": ready,
        "allowedVehicleTypes": list(types),
        "shareable": shareable,
        "lockedVehicleId": locked,
    }


def tariffs() -> list[Json]:
    return [
        {"vehicleType": "TAXI", "department": "*", "baseFare": 13, "pricePerKm": 1.12, "includedKm": 0,
         "sharedDiscount2": 0.23, "sharedDiscount3": 0.35},
        {"vehicleType": "VSL", "department": "*", "baseFare": 13.6, "pricePerKm": 1.0, "includedKm": 0,
         "sharedDiscount2": 0.23, "sharedDiscount3": 0.35},
        {"vehicleType": "AMBULANCE", "department": "*", "baseFare": 64.5, "pricePerKm": 2.4, "includedKm": 3,
         "sharedDiscount2": 0, "sharedDiscount3": 0},
    ]


def request(vehicles: list[Json], trips: list[Json], **setting_overrides: Any) -> Json:
    return {
        "date": "2026-11-03",
        "settings": settings(**setting_overrides),
        "vehicles": vehicles,
        "trips": trips,
        "tariffs": tariffs(),
    }


def optimize_request(raw: Json) -> OptimizeRequest:
    return OptimizeRequest.model_validate(raw)


def evaluate_request(raw: Json, routes: dict[str, list[tuple[str, str]]]) -> EvaluateRequest:
    """`routes`: vehicle id -> [(trip id, "PICKUP" | "DROPOFF"), ...]."""
    plans = [
        {"vehicleId": vehicle_id, "stops": [{"tripId": t, "kind": k} for t, k in stops]}
        for vehicle_id, stops in routes.items()
    ]
    return EvaluateRequest.model_validate({**raw, "routes": plans})


def offset(point: Point, north_km: float, east_km: float) -> Point:
    """A point moved by a few km (flat approximation, fine at this scale)."""
    return (point[0] + north_km / 111.2, point[1] + east_km / 81.0)


# --------------------------------------------------------------------------- generated day

FACILITIES: dict[str, tuple[str, Point]] = {
    "fac_marseille_timone": ("marseille", (43.2897, 5.4026)),
    "fac_marseille_nord": ("marseille", (43.3400, 5.3600)),
    "fac_aix_ch": ("aix", (43.5260, 5.4380)),
    "fac_manosque_ch": ("manosque", (43.8350, 5.7900)),
    "fac_sisteron_dialyse": ("sisteron", (44.1900, 5.9450)),
    "fac_gap_ch": ("gap", (44.5600, 6.0800)),
    "fac_grenoble_chu": ("grenoble", (45.1990, 5.7350)),
}
CITIES: dict[str, Point] = {
    "marseille": MARSEILLE,
    "aix": AIX,
    "manosque": MANOSQUE,
    "sisteron": SISTERON,
    "gap": GAP,
    "grenoble": GRENOBLE,
}
SHARING_PAIR = ("share_a_out", "share_b_out")
"""Two neighbours going to the same facility for the same appointment: they must ride together."""


def generated_fleet() -> list[Json]:
    return [
        vehicle("taxi_marseille", MARSEILLE, department="13", break_=STANDARD_BREAK),
        vehicle("taxi_aix", AIX, department="13", break_=STANDARD_BREAK),
        vehicle("taxi_manosque", MANOSQUE, department="04", break_=STANDARD_BREAK),
        vehicle("taxi_gap", GAP, department="05", break_=STANDARD_BREAK),
        vehicle("vsl_marseille", MARSEILLE, type_="VSL", department="13", break_=STANDARD_BREAK),
        vehicle("vsl_aix", AIX, type_="VSL", department="13", break_=STANDARD_BREAK),
        vehicle("vsl_sisteron", SISTERON, type_="VSL", department="04", break_=STANDARD_BREAK),
        vehicle("vsl_grenoble", GRENOBLE, type_="VSL", department="38", break_=STANDARD_BREAK),
        vehicle("amb_marseille", MARSEILLE, type_="AMBULANCE", department="13", break_=STANDARD_BREAK),
        vehicle("amb_gap", GAP, type_="AMBULANCE", department="05", break_=STANDARD_BREAK),
    ]


def generated_day(seed: int = 7, time_limit_sec: int = 5) -> Json:
    """About 60 trips (30 patients, outbound + return) for 10 vehicles along the axis."""
    rng = random.Random(seed)
    homes_per_city = [
        ("marseille", 10), ("aix", 8), ("manosque", 3), ("sisteron", 2), ("gap", 3), ("grenoble", 2),
    ]
    ambulance_patients = {"marseille": 2, "gap": 1}
    trips: list[Json] = []

    def add_patient(pid: str, home: Point, facility: str, appointment: int, session: int, types: tuple[str, ...],
                    shareable: bool, out_id: str | None = None) -> None:
        fac_point = FACILITIES[facility][1]
        trips.append(trip(out_id or f"{pid}_out", pid, "OUTBOUND", home, fac_point, appointment=appointment,
                          types=types, shareable=shareable, facility=facility))
        trips.append(trip(f"{pid}_ret", pid, "RETURN", fac_point, home, ready=appointment + session,
                          types=types, shareable=shareable, facility=facility))

    index = 0
    for city, count in homes_per_city:
        facilities = [fid for fid, (fcity, _) in FACILITIES.items() if fcity == city]
        for n in range(count):
            index += 1
            pid = f"pat_{index:02d}"
            home = offset(CITIES[city], rng.uniform(-4, 4), rng.uniform(-4, 4))
            ambulance = n < ambulance_patients.get(city, 0)
            appointment = rng.choice([450, 480, 510, 540, 570, 600, 840, 870])
            session = rng.choice([120, 150, 180, 240])
            if appointment + session > 1020:
                appointment = 840
                session = 120
            types = ("AMBULANCE",) if ambulance else ("TAXI", "VSL")
            shareable = (not ambulance) and rng.random() < 0.8
            add_patient(pid, home, rng.choice(facilities), appointment, session, types, shareable)

    # The sharing pair: two Marseille neighbours, dialysis in Aix at 08:00.
    home_a = (43.3100, 5.3900)
    add_patient("share_a", home_a, "fac_aix_ch", 480, 180, ("TAXI", "VSL"), True, out_id=SHARING_PAIR[0])
    add_patient("share_b", offset(home_a, 0.3, 0.2), "fac_aix_ch", 480, 180, ("TAXI", "VSL"), True,
                out_id=SHARING_PAIR[1])
    return request(generated_fleet(), trips, timeLimitSec=time_limit_sec)


# --------------------------------------------------------------------------- busy day

BUSY_SHIFTS: list[tuple[int, int]] = [(360, 1140), (420, 1080), (360, 960), (480, 1200), (330, 930), (450, 1110)]


def busy_fleet() -> list[Json]:
    """16 vehicles along the axis, mixed shifts, a midday break for all but two of them."""
    plan: list[tuple[str, Point, str, str]] = [
        ("TAXI", MARSEILLE, "13", "taxi_marseille_1"), ("TAXI", MARSEILLE, "13", "taxi_marseille_2"),
        ("TAXI", AIX, "13", "taxi_aix"), ("TAXI", MANOSQUE, "04", "taxi_manosque"),
        ("TAXI", GAP, "05", "taxi_gap"), ("TAXI", GRENOBLE, "38", "taxi_grenoble"),
        ("VSL", MARSEILLE, "13", "vsl_marseille_1"), ("VSL", MARSEILLE, "13", "vsl_marseille_2"),
        ("VSL", AIX, "13", "vsl_aix"), ("VSL", SISTERON, "04", "vsl_sisteron"),
        ("VSL", GAP, "05", "vsl_gap"), ("VSL", GRENOBLE, "38", "vsl_grenoble"),
        ("AMBULANCE", MARSEILLE, "13", "amb_marseille"), ("AMBULANCE", AIX, "13", "amb_aix"),
        ("AMBULANCE", GAP, "05", "amb_gap"), ("AMBULANCE", GRENOBLE, "38", "amb_grenoble"),
    ]
    fleet: list[Json] = []
    for n, (type_, depot, department, vehicle_id) in enumerate(plan):
        break_ = None if n in (5, 11) else STANDARD_BREAK
        shift = BUSY_SHIFTS[n % len(BUSY_SHIFTS)]
        fleet.append(vehicle(vehicle_id, depot, type_=type_, department=department, shift=shift, break_=break_))
    return fleet


BUSY_LOCKS: dict[str, str] = {
    "busy_005_out": "taxi_marseille_1",
    "busy_032_out": "vsl_aix",
    "busy_062_out": "taxi_gap",
    "busy_075_ret": "vsl_grenoble",
}
"""A few trips frozen by the regulator on a vehicle of their city."""


def busy_day(seed: int = 11, time_limit_sec: int = 10) -> Json:
    """160 trips (80 patients, outbound + return), 16 vehicles, ~12 % ambulance trips, 4 locks."""
    rng = random.Random(seed)
    homes_per_city = [("marseille", 26), ("aix", 20), ("manosque", 6), ("sisteron", 6), ("gap", 12), ("grenoble", 10)]
    ambulance_patients = {"marseille": 3, "aix": 2, "manosque": 1, "gap": 2, "grenoble": 2}
    elsewhere = {"manosque": "fac_aix_ch", "sisteron": "fac_gap_ch", "gap": "fac_grenoble_chu", "aix": "fac_marseille_timone"}
    trips: list[Json] = []
    index = 0
    for city, count in homes_per_city:
        local = [fid for fid, (fcity, _) in FACILITIES.items() if fcity == city]
        for n in range(count):
            index += 1
            pid = f"busy_{index:03d}"
            home = offset(CITIES[city], rng.uniform(-5, 5), rng.uniform(-5, 5))
            ambulance = n < ambulance_patients.get(city, 0)
            facility = elsewhere[city] if city in elsewhere and rng.random() < 0.15 else rng.choice(local)
            appointment = rng.choice([450, 480, 510, 540, 570, 600, 630, 660, 720, 780, 810, 840, 870, 900])
            session = rng.choice([60, 90, 120, 150, 180, 240])
            if appointment + session > 1050:
                session = 1050 - appointment
            types = ("AMBULANCE",) if ambulance else ("TAXI", "VSL")
            shareable = (not ambulance) and rng.random() < 0.8
            fac_point = FACILITIES[facility][1]
            for direction, trip_id in (("OUTBOUND", f"{pid}_out"), ("RETURN", f"{pid}_ret")):
                outbound = direction == "OUTBOUND"
                trips.append(
                    trip(trip_id, pid, direction, home if outbound else fac_point, fac_point if outbound else home,
                         appointment=appointment if outbound else None,
                         ready=None if outbound else appointment + session,
                         types=types, shareable=shareable, facility=facility, locked=BUSY_LOCKS.get(trip_id))
                )
    return request(busy_fleet(), trips, timeLimitSec=time_limit_sec)
