"""Search quality (OPT-08): the plan in place as a start (contract `initialRoutes`), never a worse
plan than it, and a short search from every start before the rest of the time goes to the best."""

from __future__ import annotations

import time
from typing import Any

import pytest
from pydantic import ValidationError

from app import service, solver
from app.context import make_context, request_points
from app.matrix import build_matrix
from app.plan import PlanOutcome, build_response, plan_margin
from app.schemas import EvaluateRequest, OptimizeRequest, PlanResponse, RoutePlan, StopRef
from tests.builders import AIX, MARSEILLE, STANDARD_BREAK, generated_day, offset, request, trip, vehicle

AIX_FAC = (43.5260, 5.4380)
HOME_A = offset(MARSEILLE, 3, 2)
NO_DEADLINE_SEC = 300.0


def day_model(raw: dict[str, Any]) -> solver._DayModel:
    parsed = OptimizeRequest.model_validate(raw)
    ctx = make_context(parsed, build_matrix(request_points(parsed))[0])
    fleet, _ = solver.usable_fleet(ctx)
    routable = []
    for t in parsed.trips:
        candidates, reason = solver.screen_trip(ctx, t, fleet)
        if reason is None:
            routable.append((t, candidates))
    return solver._DayModel(ctx, fleet, routable, parsed.initial_routes or ())


def routes_of(plan: PlanResponse) -> list[dict[str, Any]]:
    """The plan's stop sequences, as the web sends the routes in place."""
    return [
        {"vehicleId": route.vehicle_id, "stops": [{"tripId": s.trip_id, "kind": s.kind} for s in route.stops]}
        for route in plan.routes
    ]


def plans(*routes: tuple[str, list[tuple[str, str]]]) -> list[RoutePlan]:
    return [
        RoutePlan.model_validate({"vehicleId": v, "stops": [{"tripId": t, "kind": k} for t, k in stops]}) for v, stops in routes
    ]


def score(raw: dict[str, Any], plan: PlanResponse) -> float:
    """What the objective weighs (euros): penalty per trip left out and per patient not served both
    ways, minus the margin."""
    penalty = raw["settings"]["unassignedPenalty"]
    left_out = {u.trip_id for u in plan.unassigned}
    legs: dict[str, set[str]] = {}
    for t in raw["trips"]:
        legs.setdefault(t["patientId"], set()).add(t["direction"])
    broken = {
        t["patientId"] for t in raw["trips"] if t["id"] in left_out and legs[t["patientId"]] == {"OUTBOUND", "RETURN"}
    }
    return penalty * (len(left_out) + len(broken)) - plan.kpis.margin


def sequences_by_vehicle(plan: PlanResponse) -> dict[str, list[tuple[str, str]]]:
    return {route.vehicle_id: [(s.trip_id, s.kind) for s in route.stops] for route in plan.routes}


# --------------------------------------------------------------------------- contract


def test_initial_routes_are_part_of_the_optimize_request_only() -> None:
    raw = request([vehicle("taxi", MARSEILLE)], [trip("t", "p", "OUTBOUND", HOME_A, AIX_FAC, appointment=600)])
    in_place = [{"vehicleId": "taxi", "stops": [{"tripId": "t", "kind": "PICKUP"}, {"tripId": "t", "kind": "DROPOFF"}]}]
    assert OptimizeRequest.model_validate(raw).initial_routes is None
    parsed = OptimizeRequest.model_validate({**raw, "initialRoutes": in_place})
    assert parsed.initial_routes is not None and parsed.initial_routes[0].vehicle_id == "taxi"
    with pytest.raises(ValidationError):
        EvaluateRequest.model_validate({**raw, "routes": in_place, "initialRoutes": in_place})


def test_plan_margin_is_the_margin_of_the_response() -> None:
    raw = generated_day(time_limit_sec=1)
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    model = day_model(raw)
    sequences = {r.vehicle_id: [StopRef(trip_id=s.trip_id, kind=s.kind) for s in r.stops] for r in plan.routes}
    margin, served = plan_margin(model.ctx, sequences)
    assert abs(margin - plan.kpis.margin) < 0.05
    assert served == {t.trip_id for t in plan.trips if t.vehicle_id is not None}


# --------------------------------------------------------------------------- repair of the plan in place


def two_taxis_day() -> dict[str, Any]:
    """Two taxis (Marseille, Aix), three outbound trips to the Aix facility and one ambulance trip."""
    trips = [
        trip("early", "p1", "OUTBOUND", HOME_A, AIX_FAC, appointment=540),
        trip("late", "p2", "OUTBOUND", offset(HOME_A, 1, 0), AIX_FAC, appointment=720),
        trip("aix", "p3", "OUTBOUND", offset(AIX, 2, 1), AIX_FAC, appointment=600),
        trip("lying", "p4", "OUTBOUND", HOME_A, AIX_FAC, appointment=660, types=("AMBULANCE",), shareable=False),
    ]
    fleet = [vehicle("taxi_m", MARSEILLE), vehicle("taxi_a", AIX), vehicle("amb", MARSEILLE, type_="AMBULANCE")]
    return request(fleet, trips)


def test_plan_in_place_that_holds_is_kept_as_it_is() -> None:
    raw = two_taxis_day()
    model = day_model(raw)
    given = plans(
        ("taxi_m", [("early", "PICKUP"), ("early", "DROPOFF"), ("late", "PICKUP"), ("late", "DROPOFF")]),
        ("taxi_a", [("aix", "PICKUP"), ("aix", "DROPOFF")]),
        ("amb", [("lying", "PICKUP"), ("lying", "DROPOFF")]),
    )
    routes = model._from_plan(given, time.monotonic() + NO_DEADLINE_SEC)
    assert {v: [(r.trip_id, r.kind) for r in refs] for v, refs in model.sequences(routes).items()} == {
        p.vehicle_id: [(s.trip_id, s.kind) for s in p.stops] for p in given
    }


def test_plan_in_place_loses_what_breaks_the_rules_and_gets_the_rest_back() -> None:
    raw = two_taxis_day()
    model = day_model(raw)
    m, a, amb = range(3)

    def stops(*trips: str) -> list[int]:
        return [model.manager.NodeToIndex(n) for t in trips for n in model.trip_nodes[t]]

    # "early" (RDV 09:00) after "late" (RDV 12:00) cannot be on time: it leaves, "late" stays.
    assert model._late_trip(m, stops("late", "early")) == "early"
    assert model._late_trip(m, stops("early", "late")) is None
    assert model._trip_ids(model._kept_in_place(m, stops("late", "early"))) == ["late"]

    given = plans(
        ("gone", [("aix", "PICKUP"), ("aix", "DROPOFF")]),  # vehicle not in the request
        (
            "taxi_m",
            [
                ("lying", "PICKUP"),  # ambulance trip on a taxi
                ("lying", "DROPOFF"),
                ("ghost", "PICKUP"),  # trip not in the request
                ("ghost", "DROPOFF"),
                ("late", "PICKUP"),
                ("late", "DROPOFF"),
                ("early", "PICKUP"),
                ("early", "DROPOFF"),
            ],
        ),
        # Dropoff before pickup, and a trip already on another route.
        ("taxi_a", [("aix", "DROPOFF"), ("aix", "PICKUP"), ("late", "PICKUP"), ("late", "DROPOFF")]),
    )
    routes = model._from_plan(given, time.monotonic() + NO_DEADLINE_SEC)
    assert "late" in model._trip_ids(routes[m]) and "late" not in model._trip_ids(routes[a])
    assert model._trip_ids(routes[amb]) == ["lying"]
    # What left the routes in place went back where it fits.
    assert sorted(t for route in routes for t in model._trip_ids(route)) == ["aix", "early", "late", "lying"]
    assert all(model._fits(v, route) for v, route in enumerate(routes))


def test_plan_in_place_loses_the_trips_over_the_seats() -> None:
    raw = two_taxis_day()
    raw["vehicles"][0]["capacity"] = 1
    model = day_model(raw)
    both = [model.manager.NodeToIndex(n) for n in (*model.trip_nodes["early"], *model.trip_nodes["late"])]
    overlapping = [both[0], both[2], both[1], both[3]]  # early picked up, then late, then both dropped
    assert model._overloaded(0, overlapping) == {"late"}
    assert model._overloaded(0, both) == set()


def test_vehicles_without_a_route_in_place_still_take_their_break() -> None:
    raw = two_taxis_day()
    for v in raw["vehicles"]:
        v["break"] = STANDARD_BREAK
    model = day_model(raw)
    routes = model._from_plan(plans(("taxi_m", [("early", "PICKUP"), ("early", "DROPOFF")])), time.monotonic() + NO_DEADLINE_SEC)
    assert all(any(model.node_at(i).role is solver.Role.BREAK for i in routes[v]) for v in model.break_nodes)
    assert model.routing.ReadAssignmentFromRoutes(routes, True) is not None


# --------------------------------------------------------------------------- never worse than the plan in place


def breaks_alone(self: solver._DayModel, starts: Any, deadline: float) -> Any:
    """A search (_portfolio) that only finds the breaks alone."""
    return self.routing.ReadAssignmentFromRoutes(self._breaks_only_routes(), True)


def test_the_plan_in_place_is_returned_when_the_search_finds_worse(monkeypatch: pytest.MonkeyPatch) -> None:
    """With a search that only finds the breaks alone, the plan in place (repaired) comes back."""
    raw = generated_day(time_limit_sec=2)
    in_place = service.optimize(OptimizeRequest.model_validate(raw))
    assert in_place.validation.valid and in_place.kpis.trips_served >= 50

    monkeypatch.setattr(solver._DayModel, "_portfolio", breaks_alone)
    assert service.optimize(OptimizeRequest.model_validate(raw)).kpis.trips_served == 0
    again = service.optimize(OptimizeRequest.model_validate({**raw, "initialRoutes": routes_of(in_place)}))
    assert again.validation.valid, again.validation.violations[:5]
    assert again.kpis.trips_served >= in_place.kpis.trips_served
    assert score(raw, again) <= score(raw, in_place) + 0.01
    # Each vehicle keeps its stops in place, in the same order.
    kept = sequences_by_vehicle(again)
    for vehicle_id, stops in sequences_by_vehicle(in_place).items():
        assert [stop for stop in kept[vehicle_id] if stop in stops] == stops


def test_a_plan_in_place_the_routing_model_rejects_is_never_returned(monkeypatch: pytest.MonkeyPatch) -> None:
    """The final comparison does not look at the rules: a plan in place the routing model refused
    as a start is not a candidate either, even against a search that only finds the breaks alone."""
    raw = generated_day(time_limit_sec=2)
    in_place = service.optimize(OptimizeRequest.model_validate(raw))
    confirmed = solver._DayModel._confirmed

    def refused_in_place(self: solver._DayModel, label: str, routes: list[list[int]]) -> list[solver._Start]:
        return [] if label == "plan in place" else confirmed(self, label, routes)

    monkeypatch.setattr(solver._DayModel, "_confirmed", refused_in_place)
    monkeypatch.setattr(solver._DayModel, "_portfolio", breaks_alone)
    again = service.optimize(OptimizeRequest.model_validate({**raw, "initialRoutes": routes_of(in_place)}))
    assert again.kpis.trips_served == 0
    model = day_model({**raw, "initialRoutes": routes_of(in_place)})
    model._python_starts(time.monotonic() + 60, time.monotonic() + 60)
    assert model.warm_routes is None


def test_the_final_passes_run_once_when_the_search_returns_the_plan_in_place(monkeypatch: pytest.MonkeyPatch) -> None:
    """Re-optimizing without change usually ends on the plan in place itself: its final check and
    pair repair are not run a second time (they would give the same plan, and cost up to 8 s)."""
    raw = generated_day(time_limit_sec=2)
    in_place = service.optimize(OptimizeRequest.model_validate(raw))

    def the_plan_in_place(self: solver._DayModel, starts: Any, deadline: float) -> Any:
        return next(start.solution for start in starts if start.label == "plan in place")

    # (pass, when it started, when its own time limit ends)
    passes: list[tuple[str, float, float]] = []
    guarded, restore_pairs = solver._DayModel.guarded, solver._DayModel.restore_pairs

    def timed_guard(self: solver._DayModel, routes: list[list[int]], seconds: float = solver.GUARD_SEC) -> dict[str, str]:
        now = time.monotonic()
        passes.append(("guard", now, now + seconds))
        return guarded(self, routes, seconds)

    def timed_pairs(self: solver._DayModel, routes: list[list[int]], seconds: float = solver.PAIR_REPAIR_SEC) -> int:
        now = time.monotonic()
        passes.append(("pairs", now, now + seconds))
        return restore_pairs(self, routes, seconds)

    monkeypatch.setattr(solver._DayModel, "_portfolio", the_plan_in_place)
    monkeypatch.setattr(solver._DayModel, "guarded", timed_guard)
    monkeypatch.setattr(solver._DayModel, "restore_pairs", timed_pairs)
    again = service.optimize(OptimizeRequest.model_validate({**raw, "initialRoutes": routes_of(in_place)}))
    assert again.kpis.trips_served >= in_place.kpis.trips_served
    assert [name for name, _, _ in passes] == ["guard", "pairs"]
    # Against another plan, both get their passes, all within one budget.
    passes.clear()
    monkeypatch.setattr(solver._DayModel, "_portfolio", breaks_alone)
    service.optimize(OptimizeRequest.model_validate({**raw, "initialRoutes": routes_of(in_place)}))
    assert [name for name, _, _ in passes] == ["guard", "pairs", "guard", "pairs"]
    first = passes[0][1]
    assert all(ends <= first + solver.GUARD_SEC + solver.PAIR_REPAIR_SEC + 0.1 for _, _, ends in passes)
    assert solver._seconds_left(time.monotonic() - 1, 3.0) == 0.0
    assert solver._seconds_left(time.monotonic() + 10, 3.0) == 3.0


def test_reoptimizing_a_planned_day_without_change_is_at_least_as_good() -> None:
    """The acceptance rule of OPT-08: re-optimizing a date that has routes, nothing changed, never
    scores worse under the objective (unassignedPenalty per trip left out and per patient not served
    both ways, minus the margin). That is a weighted sum, not a strict order: one more trip served
    may be traded for one fewer half-served patient. This day serves as many trips again."""
    raw = generated_day(time_limit_sec=2)
    first = service.optimize(OptimizeRequest.model_validate(raw))
    again = service.optimize(OptimizeRequest.model_validate({**raw, "initialRoutes": routes_of(first)}))
    assert again.validation.valid, again.validation.violations[:5]
    assert again.kpis.trips_served >= first.kpis.trips_served
    assert score(raw, again) <= score(raw, first) + 0.01


def test_a_poor_plan_in_place_does_not_hold_the_search_back() -> None:
    """A plan in place with a single trip: the search from the other starts gives the full plan."""
    raw = generated_day(time_limit_sec=2)
    reference = service.optimize(OptimizeRequest.model_validate(raw))
    lone = reference.trips[0].trip_id
    poor = [{"vehicleId": reference.trips[0].vehicle_id, "stops": [{"tripId": lone, "kind": "PICKUP"}, {"tripId": lone, "kind": "DROPOFF"}]}]
    again = service.optimize(OptimizeRequest.model_validate({**raw, "initialRoutes": poor}))
    assert again.validation.valid, again.validation.violations[:5]
    assert again.kpis.trips_served >= reference.kpis.trips_served - 2


# --------------------------------------------------------------------------- starts and their search


def test_both_insertion_orders_are_starts_when_a_search_follows(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = generated_day()
    model = day_model(raw)
    distinct = model._built_from_breaks(time.monotonic() + NO_DEADLINE_SEC) != model._built_from_breaks(
        time.monotonic() + NO_DEADLINE_SEC, pairs_first=False
    )
    labels = [start.label for start in model._python_starts(time.monotonic() + 60, time.monotonic() + 60)]
    assert labels == (["insertion", "insertion by regret"] if distinct else ["insertion"])
    # No search on a large fleet (first solution skipped): one insertion only.
    monkeypatch.setattr(solver, "FIRST_SOLUTION_SEC_PER_NODE3", 1.0)
    model = day_model(raw)
    assert [start.label for start in model._python_starts(time.monotonic() + 60, time.monotonic() + 60)] == ["insertion"]


def test_insertion_by_regret_alone_ignores_the_served_leg(monkeypatch: pytest.MonkeyPatch) -> None:
    model = day_model(generated_day())
    seen: list[bool] = []
    original = solver._DayModel._next_insertion

    def spy(self: solver._DayModel, options: Any, placed: set[str]) -> tuple[str, int]:
        seen.append(bool(placed))
        return original(self, options, placed)

    monkeypatch.setattr(solver._DayModel, "_next_insertion", spy)
    model._built_from_breaks(time.monotonic() + NO_DEADLINE_SEC, pairs_first=False)
    assert seen and not any(seen)
    seen.clear()
    model._built_from_breaks(time.monotonic() + NO_DEADLINE_SEC)
    assert any(seen)


def test_the_search_goes_on_from_the_start_whose_short_search_ends_best(monkeypatch: pytest.MonkeyPatch) -> None:
    """The cheapest start is not always the one whose search ends best (2026-11-10 of the demo):
    every start gets a short search, the best plan found gets the rest of the time."""
    model = day_model(generated_day())
    cheap_routes = model._built_from_breaks(time.monotonic() + NO_DEADLINE_SEC)
    cheap = model.routing.ReadAssignmentFromRoutes(cheap_routes, True)
    costly_routes = model._breaks_only_routes()
    costly = model.routing.ReadAssignmentFromRoutes(costly_routes, True)
    assert cheap is not None and costly is not None
    assert cheap.ObjectiveValue() < costly.ObjectiveValue()
    better = model.routing.SolveFromAssignmentWithParameters(cheap, model._params(1))
    assert better is not None and better.ObjectiveValue() < cheap.ObjectiveValue()
    calls: list[tuple[str, float]] = []
    names = {id(cheap): "cheap", id(costly): "costly", id(better): "better"}

    def fake_search(self: solver._DayModel, start: Any, seconds: float) -> tuple[Any, str]:
        calls.append((names[id(start)], seconds))
        # Stuck where the cheap start is; from the costly one, the better plan.
        return (better if start is costly else start), "ROUTING_SUCCESS"

    monkeypatch.setattr(solver._DayModel, "_local_search", fake_search)
    starts = [solver._Start("cheap", cheap, cheap_routes), solver._Start("costly", costly, costly_routes)]
    chosen = model._portfolio(starts, time.monotonic() + 10)
    assert chosen is better and model.start_label == "costly"
    assert [name for name, _ in calls] == ["cheap", "costly", "better"]
    assert calls[0][1] == pytest.approx(10 * solver.PROBE_SHARE / 2, abs=0.2)
    # Not enough time for a search per start: the cheapest one alone.
    calls.clear()
    model._portfolio(starts, time.monotonic() + 2 * solver.MIN_PROBE_SEC)
    assert [name for name, _ in calls] == ["cheap"]


def test_identical_starts_are_searched_once(monkeypatch: pytest.MonkeyPatch) -> None:
    model = day_model(generated_day())
    routes = model._built_from_breaks(time.monotonic() + NO_DEADLINE_SEC)
    one = model.routing.ReadAssignmentFromRoutes(routes, True)
    calls: list[float] = []

    def fake_search(self: solver._DayModel, start: Any, seconds: float) -> tuple[Any, str]:
        calls.append(seconds)
        return start, "ROUTING_SUCCESS"

    monkeypatch.setattr(solver._DayModel, "_local_search", fake_search)
    model._portfolio([solver._Start("a", one, routes), solver._Start("b", one, [list(r) for r in routes])], time.monotonic() + 10)
    assert len(calls) == 1 and calls[0] > 9  # a single start: searched once, for the whole time


def test_checked_plan_of_a_warm_start_is_valid() -> None:
    """The plan in place repaired agrees with the routing model and the independent validator."""
    raw = generated_day(time_limit_sec=2)
    in_place = service.optimize(OptimizeRequest.model_validate(raw))
    model = day_model({**raw, "initialRoutes": routes_of(in_place)})
    routes = model._from_plan(model.initial_routes, time.monotonic() + NO_DEADLINE_SEC)
    assignment = model.routing.ReadAssignmentFromRoutes(routes, True)
    assert assignment is not None
    outcome = PlanOutcome(model.sequences(routes), {}, "-", "OK", "TEST", None)
    plan = build_response(model.ctx, outcome, time.perf_counter())
    assert plan.validation.valid, plan.validation.violations[:5]
    assert plan.kpis.trips_served >= in_place.kpis.trips_served
