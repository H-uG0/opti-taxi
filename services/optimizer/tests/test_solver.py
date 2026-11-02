"""Solver on the contract fixture, on a generated day of ~60 trips, and on targeted rules."""

from __future__ import annotations

from typing import Any

import pytest

from app import service, solver
from app.context import make_context, request_points
from app.matrix import build_matrix
from app.schemas import OptimizeRequest, PlanResponse, Route
from tests.builders import (
    AIX,
    GAP,
    MARSEILLE,
    SHARING_PAIR,
    STANDARD_BREAK,
    generated_day,
    load_fixture,
    offset,
    request,
    trip,
    vehicle,
)

AIX_FAC = (43.5260, 5.4380)


def optimize(raw: dict[str, Any]) -> PlanResponse:
    return service.optimize(OptimizeRequest.model_validate(raw))


def route_of(plan: PlanResponse, vehicle_id: str) -> Route:
    return next(r for r in plan.routes if r.vehicle_id == vehicle_id)


@pytest.fixture(scope="module")
def fixture_plan() -> PlanResponse:
    raw = load_fixture("optimize-request.json")
    raw["settings"]["timeLimitSec"] = 1
    return optimize(raw)


def test_fixture_plan_is_valid_and_complete(fixture_plan: PlanResponse) -> None:
    assert fixture_plan.status == "OK"
    assert fixture_plan.validation.valid, fixture_plan.validation.violations
    assert fixture_plan.kpis.trips_served == 7
    assert fixture_plan.meta.matrix_source == "haversine"
    assert fixture_plan.meta.objective is not None


def test_fixture_ambulance_patients_ride_alone(fixture_plan: PlanResponse) -> None:
    results = {t.trip_id: t for t in fixture_plan.trips}
    for trip_id in ("trip_5", "trip_6"):
        assert results[trip_id].vehicle_id == "veh_amb_1"
        assert not results[trip_id].shared
    assert all(stop.load_after <= 1 for stop in route_of(fixture_plan, "veh_amb_1").stops)


def test_fixture_lock_is_respected(fixture_plan: PlanResponse) -> None:
    results = {t.trip_id: t for t in fixture_plan.trips}
    assert results["trip_7"].vehicle_id == "veh_vsl_1"


def test_fixture_neighbours_share_the_taxi(fixture_plan: PlanResponse) -> None:
    results = {t.trip_id: t for t in fixture_plan.trips}
    assert results["trip_1"].co_passenger_trip_ids == ["trip_3"]
    assert results["trip_1"].revenue < results["trip_1"].direct_km * 1.12 + 13  # sharing discount applied


@pytest.fixture(scope="module")
def generated_plan() -> PlanResponse:
    return optimize(generated_day(time_limit_sec=5))


def test_generated_day_is_valid(generated_plan: PlanResponse) -> None:
    assert generated_plan.status == "OK"
    assert generated_plan.validation.valid, generated_plan.validation.violations
    assert generated_plan.kpis.trips_total == 60


def test_generated_day_serves_most_trips(generated_plan: PlanResponse) -> None:
    assert generated_plan.kpis.trips_served >= 48
    assert all(u.reason for u in generated_plan.unassigned)


def test_generated_day_shares_neighbours_going_to_the_same_appointment(generated_plan: PlanResponse) -> None:
    results = {t.trip_id: t for t in generated_plan.trips}
    first, second = (results[trip_id] for trip_id in SHARING_PAIR)
    assert first.vehicle_id is not None and first.vehicle_id == second.vehicle_id
    assert second.trip_id in first.co_passenger_trip_ids
    assert first.shared and second.shared


def test_generated_day_drivers_get_their_break(generated_plan: PlanResponse) -> None:
    for route in generated_plan.routes:
        assert route.break_ is not None
        assert 690 <= route.break_.start_min and route.break_.end_min <= 840


def test_generated_day_ambulances_carry_one_patient(generated_plan: PlanResponse) -> None:
    for route in generated_plan.routes:
        if route.vehicle_id.startswith("amb_"):
            assert max(stop.load_after for stop in route.stops) <= 1


def test_unassigned_reasons() -> None:
    trips = [
        trip("needs_ambulance", "p1", "OUTBOUND", MARSEILLE, AIX_FAC, appointment=600, types=("AMBULANCE",), shareable=False),
        trip("locked_missing", "p2", "OUTBOUND", MARSEILLE, AIX_FAC, appointment=600, locked="veh_unknown"),
        trip("too_early", "p3", "OUTBOUND", GAP, AIX_FAC, appointment=380),
        trip("ok", "p4", "OUTBOUND", offset(MARSEILLE, 2, 2), AIX_FAC, appointment=600),
    ]
    plan = optimize(request([vehicle("taxi", MARSEILLE)], trips))
    reasons = {u.trip_id: u.reason for u in plan.unassigned}
    assert "Aucun véhicule de type autorisé (Ambulance)" in reasons["needs_ambulance"]
    assert "Véhicule figé « veh_unknown »" in reasons["locked_missing"]
    assert reasons["too_early"].startswith("Horaires inatteignables")
    assert "ok" not in reasons
    assert plan.validation.valid


def test_empty_fleet_leaves_every_trip_unassigned_without_solving() -> None:
    trips = [trip("t", "p", "OUTBOUND", MARSEILLE, AIX_FAC, appointment=600)]
    plan = optimize(request([], trips))
    assert plan.status == "OK" and plan.meta.solver_status == "NO_TRIP_TO_ROUTE"
    assert plan.routes == [] and plan.kpis.trips_unassigned == 1
    assert plan.unassigned[0].reason.startswith("Aucun véhicule de type autorisé")
    assert plan.validation.valid


def test_non_shareable_patients_never_ride_together() -> None:
    home = offset(MARSEILLE, 3, 2)
    trips = [
        trip("x", "p1", "OUTBOUND", home, AIX_FAC, appointment=480, shareable=False),
        trip("y", "p2", "OUTBOUND", offset(home, 0.2, 0.2), AIX_FAC, appointment=480),
    ]
    plan = optimize(request([vehicle("taxi", MARSEILLE), vehicle("vsl", MARSEILLE, type_="VSL")], trips))
    assert plan.validation.valid
    assert plan.kpis.shared_trips == 0
    assert plan.kpis.trips_served == 2  # two vehicles, one patient each


def test_detour_limit_prevents_sharing() -> None:
    # Homes 30 km apart on both sides of Marseille: either pickup order costs > 10 km of detour.
    trips = [
        trip("west", "p1", "OUTBOUND", offset(MARSEILLE, 0, -5), AIX_FAC, appointment=480),
        trip("east", "p2", "OUTBOUND", offset(MARSEILLE, 0, 25), AIX_FAC, appointment=480),
    ]
    plan = optimize(request([vehicle("taxi_1", MARSEILLE), vehicle("taxi_2", MARSEILLE)], trips))
    assert plan.validation.valid
    assert plan.kpis.trips_served == 2
    assert plan.kpis.shared_trips == 0


def test_vehicle_type_earning_more_wins_at_equal_cost() -> None:
    """Same costs, same depot: the taxi grid (1.12 €/km) beats the VSL grid (1.00 €/km) on 30 km."""
    trips = [trip("t", "p", "OUTBOUND", offset(MARSEILLE, 3, 2), AIX_FAC, appointment=600)]
    fleet = [
        vehicle("vsl", MARSEILLE, type_="VSL", cost_per_km=0.32, cost_per_hour=24),
        vehicle("taxi", MARSEILLE, cost_per_km=0.32, cost_per_hour=24),
    ]
    plan = optimize(request(fleet, trips))
    assert plan.trips[0].vehicle_id == "taxi"


def test_objective_gap_of_a_route_ending_before_the_break_window() -> None:
    """Known limit (README, "Limites connues"): in the model, the break of a morning-only route
    stays inside the break window (depot site from 11:30), so the objective pays the idle time up
    to the end of that break; the recomputed plan puts the break after the return and reports the
    short route. This measures that gap so that a change in the break model shows up here."""
    trips = [trip("morning", "p1", "OUTBOUND", offset(MARSEILLE, 3, 2), AIX_FAC, appointment=480)]
    plan = optimize(request([vehicle("taxi", MARSEILLE, break_=STANDARD_BREAK)], trips))
    assert plan.validation.valid, plan.validation.violations
    route = plan.routes[0]
    assert route.end_min < 690 and route.break_ is not None and route.break_.start_min >= route.end_min
    assert plan.meta.objective is not None
    gap_euros = plan.meta.objective / 100 - plan.kpis.cost
    per_minute = 24 / 60  # costPerHour of the taxi
    idle_until_break_end = 690 + 45 - route.end_min
    # The model may also leave the depot up to the 30 min arrival margin later than the plan does.
    assert (idle_until_break_end - 30) * per_minute - 0.1 <= gap_euros <= idle_until_break_end * per_minute + 0.1


def test_dropped_trips_reason_depends_on_whether_the_search_settled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same plan, two search outcomes: cut short by the time limit, or a local optimum reached."""
    home = offset(MARSEILLE, 3, 2)
    trips = [
        trip(f"t{i}", f"p{i}", "OUTBOUND", offset(home, 0, 6 * i), AIX_FAC, appointment=480, shareable=False)
        for i in range(3)
    ]
    raw = request([vehicle("taxi", MARSEILLE)], trips)  # one taxi, three exclusive rides at 08:00
    original = solver._DayModel.search

    def search_ending_with(status: str) -> Any:
        def search(self: Any, time_limit_sec: float) -> Any:
            solution = original(self, time_limit_sec)
            self.search_status = status
            return solution

        return search

    monkeypatch.setattr(solver._DayModel, "search", search_ending_with("ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED"))
    cut = optimize(raw)
    assert cut.kpis.trips_served == 1 and len(cut.unassigned) == 2
    assert all(u.reason == solver.REASON_DROPPED_TIME_LIMIT for u in cut.unassigned)
    assert any(w.startswith("Recherche interrompue par la limite de 1 s : 2 course(s) non placée(s)") for w in cut.meta.warnings)

    monkeypatch.setattr(solver._DayModel, "search", search_ending_with("ROUTING_SUCCESS"))
    settled = optimize(raw)
    assert all(u.reason == solver.REASON_DROPPED for u in settled.unassigned)
    assert not any(w.startswith("Recherche interrompue") for w in settled.meta.warnings)


def test_break_repair_rechecks_the_detour_of_shared_rides() -> None:
    """The repair drops trips in Python: it must judge detours exactly like the routing limit."""
    home = offset(MARSEILLE, 3, 2)
    trips = [
        trip("near", "p1", "OUTBOUND", home, AIX_FAC, appointment=600),
        trip("far", "p2", "OUTBOUND", offset(home, 0, 25), AIX_FAC, appointment=600),
    ]
    parsed = OptimizeRequest.model_validate(request([vehicle("taxi", MARSEILLE)], trips))
    ctx = make_context(parsed, build_matrix(request_points(parsed))[0])
    fleet, _ = solver.usable_fleet(ctx)
    model = solver._DayModel(ctx, fleet, [(t, solver.screen_trip(ctx, t, fleet)[0]) for t in parsed.trips])
    (pn, dn), (pf, df) = (tuple(model.manager.NodeToIndex(n) for n in model.trip_nodes[t]) for t in ("near", "far"))
    assert model._detour_breaches([pn, dn, pf, df]) == set()
    assert model._detour_breaches([pn, pf, dn, df]) == {"near"}  # 25 km east and back: far beyond 10 km
    assert model._without_trips([pn, pf, dn, df], {"far"}) == [pn, dn]


def test_time_limit_advice() -> None:
    assert solver.search_cut_short("ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED")
    assert not solver.search_cut_short("ROUTING_SUCCESS")
    assert solver.recommended_time_limit_sec(40) == 10
    assert solver.recommended_time_limit_sec(160) == 20
    warning = solver.time_limit_warning(10, 12, 160)
    assert warning == (
        "Recherche interrompue par la limite de 10 s : 12 course(s) non placée(s) ; "
        "un temps de calcul plus long (environ 20 s pour 160 courses) peut en placer davantage"
    )
    assert "environ" not in solver.time_limit_warning(30, 2, 160)


def test_break_is_kept_inside_a_busy_day() -> None:
    home = offset(AIX, 2, -2)
    trips = [
        trip(f"t{i}", f"p{i}", "OUTBOUND", home, AIX_FAC, appointment=appointment)
        for i, appointment in enumerate([540, 600, 660, 720, 780, 840])
    ]
    plan = optimize(request([vehicle("taxi", AIX, break_=STANDARD_BREAK)], trips))
    assert plan.validation.valid, plan.validation.violations
    route = plan.routes[0]
    assert route.break_ is not None and route.break_.end_min - route.break_.start_min == 45
    assert plan.kpis.trips_served >= 4
