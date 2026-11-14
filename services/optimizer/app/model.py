"""Planning rules shared by the solver and the scheduler.

- Derived time windows (single source of truth, contract README):
  OUTBOUND dropoff service starts in [appointment - waitBefore, appointment];
  RETURN pickup service starts in [ready, ready + waitAfter]; other stops are free (the vehicle
  shift bounds them). The facility's hours of the day (facilityOpenMin, facilityCloseMin) narrow
  the window of its stop, when the trip's own time is inside them (facility_hours_apply).
- Total wait at the facility: when waitBefore + waitAfter exceeds maxTotalWait, the windows of a
  patient's same-day OUTBOUND/RETURN pair are tightened so that any schedule inside them respects
  the budget (the arrival margin keeps priority); a leg alone waits at most maxTotalWait. The wait
  on board in front of the facility (the vehicle waiting for another patient's window) counts in
  the window of the leg: the solver checks it on the reported times (solver._on_board_breaches).
- Stop durations: the trip's own when given, else the settings'.
- Vehicle compatibility (prescribed vehicle types, regulator lock), break placement modes and the
  6-hour work limit without a break (Code du travail, art. L. 3121-16).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import Enum

from app.labels import hhmm
from app.schemas import MINUTES_PER_DAY, BreakRule, DayRequest, Settings, StopKind, Trip, Vehicle

HORIZON_MIN = 2 * MINUTES_PER_DAY
"""Latest minute of the planning horizon (the contract allows times up to the next midnight)."""
MAX_WORK_WITHOUT_BREAK_MIN = 6 * 60
"""Code du travail, art. L. 3121-16: a break of at least MIN_LEGAL_BREAK_MIN minutes is due once the
daily work reaches 6 hours. A route (depot departure to return) longer than this needs one inside it."""
MIN_LEGAL_BREAK_MIN = 20


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


def service_minutes(settings: Settings, trip: Trip, kind: StopKind) -> int:
    """Stop duration at the trip's pickup or dropoff: the trip's own (vehicle type, mobility,
    facility: set by the web), else the settings'."""
    if kind == "PICKUP":
        return trip.pickup_service_min if trip.pickup_service_min is not None else settings.pickup_service_min
    return trip.dropoff_service_min if trip.dropoff_service_min is not None else settings.dropoff_service_min


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


def facility_hours_apply(trip: Trip) -> bool:
    """The facility's hours bound the trip's stop there: some are given, and its own time (appointment
    of an OUTBOUND trip, end of session of a RETURN) is inside them. A time outside them is a data
    error the regulator must see (warning), never a trip made impossible."""
    if trip.facility_open_min is None and trip.facility_close_min is None:
        return False
    key = trip.appointment_min if trip.direction == "OUTBOUND" else trip.ready_min
    if key is None:
        return False
    if trip.facility_open_min is not None and key < trip.facility_open_min:
        return False
    return trip.facility_close_min is None or key <= trip.facility_close_min


def facility_hours_warnings(request: DayRequest) -> list[str]:
    """French warnings for the trips whose own time is outside the facility's hours given (ignored)."""
    warnings: list[str] = []
    for trip in request.trips:
        if (trip.facility_open_min is None and trip.facility_close_min is None) or facility_hours_apply(trip):
            continue
        what = "rendez-vous" if trip.direction == "OUTBOUND" else "fin de séance"
        key = trip.appointment_min if trip.direction == "OUTBOUND" else trip.ready_min
        warnings.append(
            f"Course {trip.id}\u00a0: {what} à {hhmm(key or 0)} hors des heures d'accueil de l'établissement, heures ignorées"
        )
    return warnings


def _bounded(window: Window, trip: Trip) -> Window:
    """The window narrowed by the facility's hours (facility_hours_apply checked by the caller)."""
    open_ = window.open if trip.facility_open_min is None else max(window.open, trip.facility_open_min)
    close = window.close if trip.facility_close_min is None else min(window.close, trip.facility_close_min)
    return Window(open_, close)


def derive_windows(
    request: DayRequest, now_min: int | None = None, fixed: Callable[[str], bool] = lambda _trip_id: False
) -> dict[str, TripWindows]:
    """Service time windows of every trip, keyed by trip id. On a day under way (`now_min`), a trip not picked
    up yet (`fixed` false) is picked up from now on; a return whose patient has waited past the end of their
    window since the end of the session is picked up as soon as possible (a window from now, its lateness
    reported by the validator against the session's end)."""
    settings = request.settings
    total = settings.max_total_wait_min
    # A leg without its pair waits at most the total as well (the validator checks it on its own).
    before_budget = {t.id: min(settings.wait_before_appointment_min, total) for t in request.trips}
    after_budget = {t.id: min(settings.wait_after_session_min, total) for t in request.trips}
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
            if facility_hours_apply(trip):
                dropoff = _bounded(dropoff, trip)
            windows[trip.id] = TripWindows(pickup=FREE_WINDOW, dropoff=dropoff)
        else:
            ready = trip.ready_min if trip.ready_min is not None else 0
            pickup = Window(ready, min(HORIZON_MIN, ready + after_budget[trip.id]))
            if facility_hours_apply(trip):
                pickup = _bounded(pickup, trip)
            windows[trip.id] = TripWindows(pickup=pickup, dropoff=FREE_WINDOW)
        if now_min is not None and not fixed(trip.id):
            pickup = windows[trip.id].pickup
            if trip.direction == "RETURN" and pickup.close < now_min:
                pickup = Window(now_min, min(HORIZON_MIN, now_min + after_budget[trip.id]))
            else:
                pickup = Window(max(pickup.open, now_min), pickup.close)
            windows[trip.id] = TripWindows(pickup=pickup, dropoff=windows[trip.id].dropoff)
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


def has_legal_break(vehicle: Vehicle) -> bool:
    """A break rule long enough for art. L. 3121-16 (20 consecutive minutes)."""
    rule = vehicle.break_
    return rule is not None and rule.duration_min >= MIN_LEGAL_BREAK_MIN


def work_limit_min(vehicle: Vehicle, plan: BreakPlan, shift: Window) -> int | None:
    """Longest route the vehicle may drive, None when its shift allows any length.

    A route longer than MAX_WORK_WITHOUT_BREAK_MIN needs a legal break inside it. Only a break node
    (BreakMode.NODE) of at least MIN_LEGAL_BREAK_MIN guarantees one; without a break, with a shorter
    one, or with one that always falls before the departure or after the return, the route is capped.
    """
    if shift.close - shift.open <= MAX_WORK_WITHOUT_BREAK_MIN:
        return None
    if plan.mode is BreakMode.NODE and has_legal_break(vehicle):
        return None
    return MAX_WORK_WITHOUT_BREAK_MIN


def effective_shift(vehicle: Vehicle, plan: BreakPlan) -> Window:
    """Depot departure/return bounds once the break mode is applied."""
    start, end = vehicle.shift_start_min, vehicle.shift_end_min
    rule = vehicle.break_
    if rule is not None and plan.mode == BreakMode.START_AFTER:
        start = max(start, rule.window_start_min + rule.duration_min)
    if rule is not None and plan.mode == BreakMode.END_BEFORE:
        end = min(end, rule.window_end_min - rule.duration_min)
    return Window(start, end)
