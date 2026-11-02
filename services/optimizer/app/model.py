"""Planning rules shared by the solver and the scheduler.

- Derived time windows (single source of truth, contract README):
  OUTBOUND dropoff service starts in [appointment - waitBefore, appointment];
  RETURN pickup service starts in [ready, ready + waitAfter]; other stops are free (the vehicle
  shift bounds them).
- Total wait at the facility: when waitBefore + waitAfter exceeds maxTotalWait, the windows of a
  patient's same-day OUTBOUND/RETURN pair are tightened so that any schedule inside them respects
  the budget (the arrival margin keeps priority).
- Vehicle compatibility (prescribed vehicle types, regulator lock) and break placement modes.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum

from app.schemas import MINUTES_PER_DAY, BreakRule, OptimizeRequest, Settings, StopKind, Trip, Vehicle

HORIZON_MIN = 2 * MINUTES_PER_DAY
"""Latest minute of the planning horizon (the contract allows times up to the next midnight)."""


@dataclass(frozen=True)
class Window:
    """Allowed service start minutes [open, close] of a stop."""

    open: int
    close: int

    def contains(self, minute: int) -> bool:
        return self.open <= minute <= self.close


FREE_WINDOW = Window(0, HORIZON_MIN)


@dataclass(frozen=True)
class TripWindows:
    pickup: Window
    dropoff: Window

    def for_kind(self, kind: StopKind) -> Window:
        return self.pickup if kind == "PICKUP" else self.dropoff


def service_minutes(settings: Settings, kind: StopKind) -> int:
    """Stop duration at a pickup or a dropoff."""
    return settings.pickup_service_min if kind == "PICKUP" else settings.dropoff_service_min


def same_day_pairs(trips: Sequence[Trip]) -> list[tuple[Trip, Trip]]:
    """(OUTBOUND, RETURN) pairs of the same patient: each return is matched with the latest
    unmatched outbound whose appointment is not after the end of session, same facility first."""
    by_patient: dict[str, list[Trip]] = defaultdict(list)
    for trip in trips:
        by_patient[trip.patient_id].append(trip)
    pairs: list[tuple[Trip, Trip]] = []
    for patient_trips in by_patient.values():
        outbounds = [t for t in patient_trips if t.direction == "OUTBOUND" and t.appointment_min is not None]
        returns = sorted(
            (t for t in patient_trips if t.direction == "RETURN" and t.ready_min is not None),
            key=lambda t: (t.ready_min or 0, t.id),
        )
        used: set[str] = set()
        for ret in returns:
            ready = ret.ready_min or 0
            candidates = [o for o in outbounds if o.id not in used and (o.appointment_min or 0) <= ready]
            if not candidates:
                continue
            best = max(candidates, key=lambda o: (o.facility_id == ret.facility_id, o.appointment_min or 0))
            used.add(best.id)
            pairs.append((best, ret))
    return pairs


def derive_windows(request: OptimizeRequest) -> dict[str, TripWindows]:
    """Service time windows of every trip, keyed by trip id."""
    settings = request.settings
    before_budget = {t.id: settings.wait_before_appointment_min for t in request.trips}
    after_budget = {t.id: settings.wait_after_session_min for t in request.trips}
    total = settings.max_total_wait_min
    if settings.wait_before_appointment_min + settings.wait_after_session_min > total:
        for outbound, ret in same_day_pairs(request.trips):
            before = min(settings.wait_before_appointment_min, total)
            before_budget[outbound.id] = before
            after_budget[ret.id] = max(0, min(settings.wait_after_session_min, total - before))

    windows: dict[str, TripWindows] = {}
    for trip in request.trips:
        if trip.direction == "OUTBOUND":
            appointment = trip.appointment_min if trip.appointment_min is not None else HORIZON_MIN
            dropoff = Window(max(0, appointment - before_budget[trip.id]), appointment)
            windows[trip.id] = TripWindows(pickup=FREE_WINDOW, dropoff=dropoff)
        else:
            ready = trip.ready_min if trip.ready_min is not None else 0
            pickup = Window(ready, min(HORIZON_MIN, ready + after_budget[trip.id]))
            windows[trip.id] = TripWindows(pickup=pickup, dropoff=FREE_WINDOW)
    return windows


def is_compatible(trip: Trip, vehicle: Vehicle) -> bool:
    """Prescribed vehicle type and regulator lock (both hard rules)."""
    if vehicle.type not in trip.allowed_vehicle_types:
        return False
    return trip.locked_vehicle_id is None or trip.locked_vehicle_id == vehicle.id


class BreakMode(Enum):
    """How the solver must guarantee a vehicle's driver break."""

    NONE = "none"
    """No break, or the shift always leaves the break off-route (before departure / after return)."""
    NODE = "node"
    """A break stop (vehicle empty) must be visited inside the break window."""
    START_AFTER = "start_after"
    """The window barely overlaps the shift start: leave the depot after the break."""
    END_BEFORE = "end_before"
    """The window barely overlaps the shift end: be back at the depot before the break."""
    IMPOSSIBLE = "impossible"
    """The shift is too short around the break window: the vehicle cannot be used."""


@dataclass(frozen=True)
class BreakPlan:
    mode: BreakMode
    window: Window | None = None
    """Allowed break start minutes for BreakMode.NODE."""


def break_plan(vehicle: Vehicle) -> BreakPlan:
    rule: BreakRule | None = vehicle.break_
    if rule is None or rule.duration_min == 0:
        return BreakPlan(BreakMode.NONE)
    ws, we, d = rule.window_start_min, rule.window_end_min, rule.duration_min
    start, end = vehicle.shift_start_min, vehicle.shift_end_min
    if start >= ws + d or end <= we - d:
        return BreakPlan(BreakMode.NONE)
    first, last = max(ws, start), min(we, end) - d
    if first <= last:
        return BreakPlan(BreakMode.NODE, Window(first, last))
    if ws + d <= end:
        return BreakPlan(BreakMode.START_AFTER)
    if we - d >= start:
        return BreakPlan(BreakMode.END_BEFORE)
    return BreakPlan(BreakMode.IMPOSSIBLE)


def effective_shift(vehicle: Vehicle, plan: BreakPlan) -> Window:
    """Depot departure/return bounds once the break mode is applied."""
    start, end = vehicle.shift_start_min, vehicle.shift_end_min
    rule = vehicle.break_
    if rule is not None and plan.mode == BreakMode.START_AFTER:
        start = max(start, rule.window_start_min + rule.duration_min)
    if rule is not None and plan.mode == BreakMode.END_BEFORE:
        end = min(end, rule.window_end_min - rule.duration_min)
    return Window(start, end)
