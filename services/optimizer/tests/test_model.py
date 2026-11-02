"""Derived time windows, total-wait tightening and break modes."""

from __future__ import annotations

from app.model import FREE_WINDOW, BreakMode, Window, break_plan, derive_windows, effective_shift, same_day_pairs
from app.schemas import OptimizeRequest, Vehicle
from tests.builders import AIX, MARSEILLE, request, trip, vehicle


def two_way_request(**settings: int) -> OptimizeRequest:
    trips = [
        trip("out", "pat", "OUTBOUND", MARSEILLE, AIX, appointment=480),
        trip("ret", "pat", "RETURN", AIX, MARSEILLE, ready=690),
        trip("other", "pat_2", "RETURN", AIX, MARSEILLE, ready=700),
    ]
    return OptimizeRequest.model_validate(request([vehicle("taxi", MARSEILLE)], trips, **settings))


def test_contract_windows() -> None:
    windows = derive_windows(two_way_request())
    assert windows["out"].pickup == FREE_WINDOW
    assert windows["out"].dropoff == Window(450, 480)
    assert windows["ret"].pickup == Window(690, 705)
    assert windows["ret"].dropoff == FREE_WINDOW


def test_windows_tightened_when_wait_budget_exceeds_total() -> None:
    windows = derive_windows(two_way_request(waitBeforeAppointmentMin=40, waitAfterSessionMin=20, maxTotalWaitMin=45))
    assert windows["out"].dropoff == Window(440, 480)
    assert windows["ret"].pickup == Window(690, 695)
    # A return without a same-day outbound keeps the full margin.
    assert windows["other"].pickup == Window(700, 720)


def test_same_day_pairs_match_outbound_and_return_of_a_patient() -> None:
    pairs = same_day_pairs(two_way_request().trips)
    assert [(o.id, r.id) for o, r in pairs] == [("out", "ret")]


def make_vehicle(shift: tuple[int, int], window: tuple[int, int] | None, duration: int = 45) -> Vehicle:
    rule = None if window is None else {"windowStartMin": window[0], "windowEndMin": window[1], "durationMin": duration}
    return Vehicle.model_validate(vehicle("v", MARSEILLE, shift=shift, break_=rule))


def test_break_modes() -> None:
    assert break_plan(make_vehicle((360, 1140), None)).mode is BreakMode.NONE
    plan = break_plan(make_vehicle((360, 1140), (690, 840)))
    assert plan.mode is BreakMode.NODE and plan.window == Window(690, 795)
    # Shift starting after the window: the break is always before departure.
    assert break_plan(make_vehicle((780, 1140), (690, 840))).mode is BreakMode.NONE
    # Shift ending before the end of the window: the break can always follow the return.
    assert break_plan(make_vehicle((360, 780), (690, 840))).mode is BreakMode.NONE
    # Window barely overlapping the shift start.
    tight = make_vehicle((720, 1140), (690, 760))
    assert break_plan(tight).mode is BreakMode.START_AFTER
    assert effective_shift(tight, break_plan(tight)) == Window(735, 1140)
