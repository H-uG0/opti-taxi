"""Solver rules added on 9 November 2026: wait on board at the facility and time on board (OPT-01),
km cost on the Distance dimension (OPT-02), first solution skipped at scale (OPT-03), outbound and
return kept together (OPT-04), stop durations per trip (OPT-05), 6-hour work limit (OPT-07)."""

from __future__ import annotations

from typing import Any

import pytest

from app import service, solver
from app.context import make_context, request_points
from app.matrix import build_matrix
from app.model import work_limit_min
from app.schedule import PlannedStop, schedule_route
from app.schemas import OptimizeRequest, PlanResponse
from tests.builders import AIX, MANOSQUE, MARSEILLE, STANDARD_BREAK, offset, request, trip, vehicle

AIX_FAC = (43.5260, 5.4380)
HOME_A = offset(MARSEILLE, 3, 2)
HOME_B = offset(HOME_A, 0.5, 0.5)


def optimize(raw: dict[str, Any]) -> PlanResponse:
    return service.optimize(OptimizeRequest.model_validate(raw))


def day_model(raw: dict[str, Any]) -> solver._DayModel:
    parsed = OptimizeRequest.model_validate(raw)
    ctx = make_context(parsed, build_matrix(request_points(parsed))[0])
    fleet, _ = solver.usable_fleet(ctx)
    routable = []
    for t in parsed.trips:
        candidates, reason = solver.screen_trip(ctx, t, fleet)
        if reason is None:
            routable.append((t, candidates))
    return solver._DayModel(ctx, fleet, routable)


def indices(model: solver._DayModel, *stops: tuple[str, str]) -> list[int]:
    """Routing indices of (trip id, "P" | "D") stops."""
    return [model.manager.NodeToIndex(model.trip_nodes[t][0 if kind == "P" else 1]) for t, kind in stops]


# --------------------------------------------------------------------------- OPT-01


def dialysis_day(**settings: Any) -> dict[str, Any]:
    """Patients A and B leave the Aix dialysis center at 11:00 and 11:30; A came at 07:30."""
    trips = [
        trip("a_out", "pat_a", "OUTBOUND", HOME_A, AIX_FAC, appointment=480),
        trip("a_ret", "pat_a", "RETURN", AIX_FAC, HOME_A, ready=660),
        trip("b_ret", "pat_b", "RETURN", AIX_FAC, HOME_B, ready=690),
    ]
    fleet = [vehicle("taxi_m", MARSEILLE), vehicle("taxi_aix1", AIX), vehicle("taxi_aix2", AIX)]
    return request(fleet, trips, **settings)


def test_dialysis_returns_are_not_shared_when_one_patient_would_wait_in_the_parked_taxi() -> None:
    # Sharing saves a whole drive Aix -> Marseille -> Aix: the solver takes it when it is allowed.
    allowed = optimize(dialysis_day(waitAfterSessionMin=30, maxTotalWaitMin=60))
    assert allowed.validation.valid, allowed.validation.violations
    results = {t.trip_id: t for t in allowed.trips}
    assert results["a_ret"].co_passenger_trip_ids == ["b_ret"]

    # Within 15 min after the session, A picked at 11:15 would wait 10 more minutes on board for B.
    plan = optimize(dialysis_day())
    assert plan.validation.valid, plan.validation.violations
    results = {t.trip_id: t for t in plan.trips}
    assert plan.kpis.trips_served == 3
    assert results["a_ret"].vehicle_id != results["b_ret"].vehicle_id


def test_final_check_takes_out_and_reinserts_a_patient_waiting_on_board() -> None:
    model = day_model(dialysis_day())
    taxi_aix1 = next(v for v, member in enumerate(model.fleet) if member.vehicle.id == "taxi_aix1")
    shared = indices(model, ("a_ret", "P"), ("b_ret", "P"), ("a_ret", "D"), ("b_ret", "D"))
    assert model._scheduled_breaches(taxi_aix1, shared) == {"a_ret"}
    assert model._rule_breaches(taxi_aix1, shared) == {"a_ret"}  # the Python steps see it too
    routes: list[list[int]] = [[] for _ in model.fleet]
    routes[taxi_aix1] = shared
    left_out = model.guarded(routes)
    assert left_out == {}  # reinserted on the other Aix taxi
    assert sum(1 for route in routes if route) == 2
    assert all(not model._scheduled_breaches(v, route) for v, route in enumerate(routes))


def test_time_on_board_is_limited() -> None:
    model = day_model(dialysis_day(waitAfterSessionMin=30, maxTotalWaitMin=60, maxRideExtraMin=4))
    taxi_aix1 = next(v for v, member in enumerate(model.fleet) if member.vehicle.id == "taxi_aix1")
    shared = indices(model, ("a_ret", "P"), ("b_ret", "P"), ("a_ret", "D"), ("b_ret", "D"))
    # A rides through B's pickup (5 min), B through A's dropoff and detour: more than direct + 4.
    assert model._rule_breaches(taxi_aix1, shared) == {"a_ret", "b_ret"}
    plan = optimize(dialysis_day(waitAfterSessionMin=30, maxTotalWaitMin=60, maxRideExtraMin=4))
    assert plan.validation.valid, plan.validation.violations
    assert not any(t.shared for t in plan.trips)


# --------------------------------------------------------------------------- OPT-02


def test_one_arc_cost_matrix_per_tariff_whatever_the_cost_per_km() -> None:
    fleet = [vehicle(f"taxi_{i}", MARSEILLE, cost_per_km=0.30 + 0.01 * i) for i in range(6)]
    fleet.append(vehicle("vsl", MARSEILLE, type_="VSL"))
    model = day_model(request(fleet, [trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600)]))
    assert model.cost_matrices == 2  # taxi grid, VSL grid


@pytest.mark.parametrize("rates", [(0.30, 0.60), (0.60, 0.30)])
def test_cheaper_vehicle_per_km_wins(rates: tuple[float, float]) -> None:
    fleet = [vehicle("first", MARSEILLE, cost_per_km=rates[0]), vehicle("second", MARSEILLE, cost_per_km=rates[1])]
    plan = optimize(request(fleet, [trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600)]))
    assert plan.trips[0].vehicle_id == ("first" if rates[0] < rates[1] else "second")
    route = plan.routes[0]
    assert plan.meta.objective is not None
    # The objective (cents) carries the vehicle's own km cost: route cost + nothing else here.
    assert abs(plan.meta.objective / 100 - route.cost) < 0.6


# --------------------------------------------------------------------------- OPT-03


def test_first_solution_is_skipped_when_it_cannot_finish(monkeypatch: pytest.MonkeyPatch) -> None:
    trips = [trip(f"t{i}", f"p{i}", "OUTBOUND", offset(HOME_A, i, 0), AIX_FAC, appointment=480 + 60 * i) for i in range(4)]
    raw = request([vehicle("taxi", MARSEILLE), vehicle("taxi_2", AIX)], trips)
    monkeypatch.setattr(solver, "FIRST_SOLUTION_SEC_PER_NODE3", 1.0)
    plan = optimize(raw)
    assert plan.meta.solver_status == solver.STATUS_INSERTION
    assert plan.validation.valid and plan.kpis.trips_served == 4
    assert plan.meta.wall_time_ms < 1000  # no search on the rest of the budget
    monkeypatch.setattr(solver, "FIRST_SOLUTION_SEC_PER_NODE3", 1e-12)
    assert optimize(raw).meta.solver_status != solver.STATUS_INSERTION


# --------------------------------------------------------------------------- OPT-04


def saturated_pair_day() -> dict[str, Any]:
    """One taxi at Aix, room for two of three trips: patient A's outbound (09:00) and return (11:00)
    at the Aix center, and a lone trip Manosque -> Aix (RDV 12:00, rides alone) that fits after the
    outbound but not with the return. The lone trip pays more than the short return."""
    trips = [
        trip("a_out", "pat_a", "OUTBOUND", offset(AIX, 2, 2), AIX_FAC, appointment=540),
        trip("a_ret", "pat_a", "RETURN", AIX_FAC, offset(AIX, 2, 2), ready=660),
        trip("x", "pat_x", "OUTBOUND", MANOSQUE, AIX_FAC, appointment=720, shareable=False),
    ]
    # Free to drive: only what each trip pays decides which one is left out.
    return request([vehicle("taxi", AIX, cost_per_km=0, cost_per_hour=0)], trips)


def test_return_of_a_served_outbound_beats_a_better_paid_lone_trip() -> None:
    raw = saturated_pair_day()
    model = day_model(raw)
    assert model.partner == {"a_out": "a_ret", "a_ret": "a_out"}
    assert model.drop_penalty["x"] > model.drop_penalty["a_ret"]
    # Both plans of two trips are feasible: without the pair rule, the cheaper to drop is the return.
    for legs in (("a_out", "x"), ("a_out", "a_ret")):
        assert model._fits(0, indices(model, *((t, kind) for t in legs for kind in ("P", "D"))))
    assert not model._fits(0, indices(model, ("a_out", "P"), ("a_out", "D"), ("a_ret", "P"), ("a_ret", "D"), ("x", "P"), ("x", "D")))
    plan = optimize(raw)
    assert plan.validation.valid, plan.validation.violations
    served = {t.trip_id for t in plan.trips if t.vehicle_id}
    assert served == {"a_out", "a_ret"}


def test_final_pass_gives_the_return_back_by_dropping_a_lone_trip_in_the_way() -> None:
    model = day_model(saturated_pair_day())
    # A plan with the lone trip in the return's slot: patient A is left at the center.
    routes = [indices(model, ("a_out", "P"), ("a_out", "D"), ("x", "P"), ("x", "D"))]
    assert model._fits(0, routes[0])
    assert model.restore_pairs(routes) == 1
    assert model._trip_ids(routes[0]) == ["a_out", "a_ret"]
    assert not model._scheduled_breaches(0, routes[0])


def short_session_day() -> dict[str, Any]:
    """One taxi at Aix with room for two of three trips: patient A's short session (outbound for
    08:30, return ready at 09:20: the outbound's dropoff is within the final pass's slack of the
    return) and a better-paid lone trip Aix -> south of Marseille (RDV 09:05) that fits with either
    leg but not with both."""
    trips = [
        trip("a_out", "pat_a", "OUTBOUND", offset(AIX, 2, 2), AIX_FAC, appointment=510),
        trip("a_ret", "pat_a", "RETURN", AIX_FAC, offset(AIX, 2, 2), ready=560),
        trip("x", "pat_x", "OUTBOUND", AIX_FAC, offset(MARSEILLE, -5, 0), appointment=545, shareable=False),
    ]
    return request([vehicle("taxi", AIX, cost_per_km=0, cost_per_hour=0)], trips)


def test_final_pass_never_drops_the_served_leg_of_the_patient_it_completes() -> None:
    model = day_model(short_session_day())
    assert model.drop_penalty["x"] > model.drop_penalty["a_out"]

    def route(*trips: str) -> list[int]:
        return indices(model, *((t, kind) for t in trips for kind in ("P", "D")))

    assert model._fits(0, route("a_out", "a_ret")) and model._fits(0, route("x", "a_ret"))
    assert not any(model._fits(0, route(*order)) for order in (("a_out", "x", "a_ret"), ("x", "a_out", "a_ret")))
    routes = [route("a_out", "x")]
    assert model._fits(0, routes[0])
    # Swapping the outbound (cheaper to drop than x) for the return leaves patient A half-served.
    assert model.restore_pairs(routes) == 1
    assert model._trip_ids(routes[0]) == ["a_out", "a_ret"]
    assert not model._scheduled_breaches(0, routes[0])


def test_insertion_places_the_return_of_a_served_outbound_first() -> None:
    model = day_model(dialysis_day())
    placed = {"a_out"}
    assert model._partner_rank("a_ret", placed) == 2
    assert model._partner_rank("b_ret", placed) == 0
    assert model._partner_rank("a_out", {"a_ret"}) == 1
    options = {"b_ret": {1: (100.0, [])}, "a_ret": {1: (900.0, []), 2: (900.0, [])}}
    assert model._next_insertion(options, placed) == ("a_ret", 1)  # despite B's infinite regret


# --------------------------------------------------------------------------- OPT-05


def test_stop_durations_per_trip() -> None:
    long_pickup = trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600, types=("AMBULANCE",), shareable=False)
    long_pickup.update({"pickupServiceMin": 20, "dropoffServiceMin": 12})
    plan = optimize(request([vehicle("amb", MARSEILLE, type_="AMBULANCE")], [long_pickup]))
    assert plan.validation.valid, plan.validation.violations
    pickup, dropoff = plan.routes[0].stops
    assert (pickup.departure_min - pickup.start_min, dropoff.departure_min - dropoff.start_min) == (20, 12)
    # Without them, the settings' 5 min (behaviour unchanged).
    del long_pickup["pickupServiceMin"], long_pickup["dropoffServiceMin"]
    pickup, dropoff = optimize(request([vehicle("amb", MARSEILLE, type_="AMBULANCE")], [long_pickup])).routes[0].stops
    assert (pickup.departure_min - pickup.start_min, dropoff.departure_min - dropoff.start_min) == (5, 5)


# --------------------------------------------------------------------------- OPT-07


def early_and_late_day(break_: dict[str, int] | None, vehicles: int = 1) -> dict[str, Any]:
    trips = [
        trip("early", "p1", "OUTBOUND", HOME_A, AIX_FAC, appointment=480),
        trip("late", "p2", "RETURN", AIX_FAC, HOME_A, ready=900),
    ]
    return request([vehicle(f"taxi_{i}", MARSEILLE, break_=break_) for i in range(vehicles)], trips)


def test_route_without_a_break_is_capped_at_six_hours() -> None:
    plan = optimize(early_and_late_day(None))
    assert plan.validation.valid, plan.validation.violations
    assert plan.kpis.trips_served == 1  # 07:30 to 15:40 in one route would be over 6 hours
    assert all(r.end_min - r.start_min <= 360 for r in plan.routes)
    both = optimize(early_and_late_day(None, vehicles=2))
    assert both.validation.valid and both.kpis.trips_served == 2 and len(both.routes) == 2
    with_break = optimize(early_and_late_day(STANDARD_BREAK))
    assert with_break.validation.valid, with_break.validation.violations
    assert with_break.kpis.trips_served == 2 and len(with_break.routes) == 1


def test_final_check_gives_the_work_time_reason_to_a_trip_it_leaves_out_for_the_six_hours() -> None:
    model = day_model(early_and_late_day(None))
    routes = [indices(model, ("early", "P"), ("early", "D"), ("late", "P"), ("late", "D"))]
    left_out = model.guarded(routes)
    assert len(left_out) == 1 and set(left_out.values()) == {solver.REASON_DROPPED_WORK_TIME}
    assert "L. 3121-16" in solver.REASON_DROPPED_WORK_TIME
    assert len(model._trip_ids(routes[0])) == 1
    # A patient left out for the time on board keeps the on-board reason.
    model = day_model(dialysis_day())
    taxi_aix1 = next(v for v, member in enumerate(model.fleet) if member.vehicle.id == "taxi_aix1")
    assert model._scheduled_reasons(taxi_aix1, indices(model, ("a_ret", "P"), ("b_ret", "P"), ("a_ret", "D"), ("b_ret", "D"))) == {
        "a_ret": solver.REASON_DROPPED_ON_BOARD
    }


def test_work_limit_depends_on_a_legal_break_node() -> None:
    raw = early_and_late_day(None)
    parsed = OptimizeRequest.model_validate(raw)
    ctx = make_context(parsed, build_matrix(request_points(parsed))[0])
    (member,), _ = solver.usable_fleet(ctx)
    assert member.work_limit == 360
    short = {"windowStartMin": 690, "windowEndMin": 840, "durationMin": 15}
    for rule, limit in ((STANDARD_BREAK, None), (short, 360)):
        raw["vehicles"][0]["break"] = rule
        parsed = OptimizeRequest.model_validate(raw)
        ctx = make_context(parsed, build_matrix(request_points(parsed))[0])
        (member,), _ = solver.usable_fleet(ctx)
        assert work_limit_min(member.vehicle, member.breaks, member.shift) == limit


def test_compact_timing_keeps_a_route_under_six_hours() -> None:
    """Early arrivals at the facility make the usual timing longer: a route over 6 hours without a
    break is timed with every stop as late as possible, which the solver's 6-hour cap assumes."""
    raw = early_and_late_day(None)
    parsed = OptimizeRequest.model_validate(raw)
    ctx = make_context(parsed, build_matrix(request_points(parsed))[0])
    early, late = parsed.trips
    taxi = parsed.vehicles[0]

    def stops(ready: int) -> list[PlannedStop]:
        moved = late.model_copy(update={"ready_min": ready})
        windows = {"early": ctx.windows["early"], "late": ctx.windows["late"]}
        late_window = windows["late"].pickup.__class__(ready, ready + 15)
        return [
            PlannedStop(early, "PICKUP", early.pickup, 5, windows["early"].pickup),
            PlannedStop(early, "DROPOFF", early.dropoff, 5, windows["early"].dropoff),
            PlannedStop(moved, "PICKUP", moved.pickup, 5, late_window),
            PlannedStop(moved, "DROPOFF", moved.dropoff, 5, windows["late"].dropoff),
        ]

    # The usual timing arrives 30 min before the 08:00 appointment; compact arrives at 08:00.
    usual = schedule_route(taxi, stops(600), ctx.matrix)
    assert usual.stops[1].start_min == 450 and usual.duration_min <= 360
    # Return ready so that the usual timing lasts 6 h 10: compact, the taxi leaves 30 min later.
    ready = usual.start_min + 370 - (usual.end_min - 600)
    compact = schedule_route(taxi, stops(ready), ctx.matrix)
    assert compact.duration_min == 340 and compact.stops[1].start_min == 480
