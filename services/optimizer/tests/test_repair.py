"""Repair of the plan in place and trips the search left out (OPT-09): repairing a plan the optimizer
made keeps all its trips, locks or not; break sites where a driver can rest around a lunchtime
return or a long outbound; the final passes that place the trips left out; the reason given for
those that stay out."""

from __future__ import annotations

import copy
import gzip
import json
import time
from pathlib import Path
from typing import Any

import pytest

from app import service, solver
from app.context import make_context, request_points
from app.matrix import build_matrix
from app.model import service_minutes
from app.schemas import LatLng, OptimizeRequest, PlanResponse
from app.schedule import PlannedStop, schedule_route
from tests.builders import (
    FACILITIES,
    GAP,
    MARSEILLE,
    SISTERON,
    busy_day,
    generated_day,
    latlng,
    offset,
    request,
    trip,
    vehicle,
)

SEED_FLEET_DAY = Path(__file__).resolve().parent / "data" / "seed-fleet-2026-11-11.json.gz"
"""11/11 of the large seed (pnpm db:seed --fleet: fictitious, 290 trips, 118 vehicles) as the web
sends it, with its plan in place (288 trips, made by the optimizer of November 9)."""
SEED_SMALL_PLACE_DAY = Path(__file__).resolve().parent / "data" / "seed-small-2026-11-12-place.json.gz"
"""12/11 of the small seed (pnpm db:seed: fictitious, 64 trips, 10 vehicles) as « Placer les non
affectées » sends it: the 62 trips of the plan in place locked on their vehicle, two returns left."""
AMBULANCE_RETURN = "cmw9rmlke00eskw8me549vovl"
"""The return of SEED_SMALL_PLACE_DAY no ambulance can take: Marseille, ready at 11:30."""
AMBULANCE_GAP = "cmw9rmkjb002pkw8m2gw5ag7y"
NO_DEADLINE_SEC = 300.0
MARSEILLE_FAC = FACILITIES["fac_marseille_timone"][1]
LUNCH_BREAK = {"windowStartMin": 690, "windowEndMin": 840, "durationMin": 30}
NBSP = solver.NBSP


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
    return [
        {"vehicleId": route.vehicle_id, "stops": [{"tripId": s.trip_id, "kind": s.kind} for s in route.stops]}
        for route in plan.routes
    ]


def pinned(raw: dict[str, Any], in_place: list[dict[str, Any]]) -> dict[str, Any]:
    """The request of « Placer les non affectées »: every trip of the plan in place locked on its vehicle."""
    where = {stop["tripId"]: route["vehicleId"] for route in in_place for stop in route["stops"]}
    day = copy.deepcopy(raw)
    for t in day["trips"]:
        if t["id"] in where and t.get("lockedVehicleId") is None:
            t["lockedVehicleId"] = where[t["id"]]
    return {**day, "initialRoutes": in_place}


def repaired_trips(raw: dict[str, Any]) -> dict[str, set[str]]:
    """Trips of each vehicle once the plan in place of `raw` is repaired (_from_plan)."""
    model = day_model(raw)
    routes = model._from_plan(model.initial_routes, time.monotonic() + NO_DEADLINE_SEC)
    return {model.fleet[v].vehicle.id: set(model._trip_ids(route)) for v, route in enumerate(routes)}


def trips_of(in_place: list[dict[str, Any]]) -> dict[str, set[str]]:
    return {route["vehicleId"]: {s["tripId"] for s in route["stops"]} for route in in_place}


def keeps_every_trip(raw: dict[str, Any]) -> None:
    """Each trip of the plan in place is still on its vehicle after the repair."""
    kept = repaired_trips(raw)
    for vehicle_id, trip_ids in trips_of(raw["initialRoutes"]).items():
        assert trip_ids <= kept[vehicle_id], (vehicle_id, sorted(trip_ids - kept[vehicle_id]))


# --------------------------------------------------------------------------- idempotence


@pytest.mark.parametrize("seed", [11, 13])
def test_repairing_its_own_plan_keeps_every_trip(seed: int) -> None:
    """The busy day's plan sent back as the plan in place, as is (re-optimization) and with every
    trip locked on its vehicle (« Placer les non affectées »): the repair keeps every trip where it
    was. Locked, busy_day(11) lost 2 returns before OPT-09: the locks took away the break sites the
    plan had used."""
    raw = busy_day(seed=seed, time_limit_sec=3)
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.validation.valid, plan.validation.violations[:5]
    in_place = routes_of(plan)
    keeps_every_trip({**raw, "initialRoutes": in_place})
    keeps_every_trip(pinned(raw, in_place))


def seed_fleet_day() -> dict[str, Any]:
    with gzip.open(SEED_FLEET_DAY, "rt", encoding="utf-8") as file:
        raw: dict[str, Any] = json.load(file)
    return raw


def test_the_plan_in_place_of_the_large_seed_keeps_its_288_trips() -> None:
    """11/11 of the large seed: the repair kept 284 of the 288 trips of « Placer les non
    affectées » before OPT-09 (the plan was made with other break sites than the request's)."""
    raw = seed_fleet_day()
    assert sum(len(trip_ids) for trip_ids in trips_of(raw["initialRoutes"]).values()) == 288
    keeps_every_trip(raw)
    keeps_every_trip(pinned(raw, raw["initialRoutes"]))


def test_placing_the_unassigned_trips_of_the_large_seed_keeps_the_288_and_places_one_more() -> None:
    """« Placer les non affectées » on 11/11 of the large seed: the 288 trips stay on their vehicle,
    the 204 km outbound for 15:00 (driver resting at the patient's home before the pickup) is placed;
    the 143 km ambulance trip has no ambulance free, and the reason says so."""
    raw = seed_fleet_day()
    request_in_place = pinned(raw, raw["initialRoutes"])
    plan = service.optimize(OptimizeRequest.model_validate(request_in_place))
    assert plan.validation.valid, plan.validation.violations[:5]
    served = {t.trip_id: t.vehicle_id for t in plan.trips if t.vehicle_id is not None}
    for vehicle_id, trip_ids in trips_of(raw["initialRoutes"]).items():
        assert all(served.get(trip_id) == vehicle_id for trip_id in trip_ids)
    assert plan.kpis.trips_served == 289
    [left] = plan.unassigned
    assert left.reason == (
        f"{solver.REASON_DROPPED_PREFIX} 06:43 à 09:00{NBSP}: "
        "Ambulance 13 (Sisteron) transporte un autre patient de 06:31 à 07:30"
    )


def test_a_lock_does_not_take_break_sites_away() -> None:
    """A trip locked on one taxi still gives its facility as a break site to the other taxi that
    could serve it: the lock says who drives it, not where a driver may rest."""
    facility = FACILITIES["fac_aix_ch"][1]
    trips = [trip("locked", "p1", "OUTBOUND", offset(facility, 3, 0), facility, appointment=600, locked="taxi_b")]
    fleet = [vehicle("taxi_a", MARSEILLE, break_=LUNCH_BREAK), vehicle("taxi_b", MARSEILLE, break_=LUNCH_BREAK)]
    model = day_model(request(fleet, trips))
    point = model.ctx.matrix.index_of(LatLng.model_validate(latlng(facility)))
    assert model._candidates["locked"] == [1]
    assert all(point in [model.nodes[n].point for n in model.break_nodes[v]] for v in (0, 1))


def test_the_break_of_the_plan_in_place_keeps_a_site(monkeypatch: pytest.MonkeyPatch) -> None:
    """The plan in place rests where no break site of this request is: the place where schedule.py
    rests becomes a site of that vehicle, and the repair keeps the route."""
    raw = shared_lunchtime_returns()
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.kpis.trips_served == 2
    monkeypatch.setattr(solver._DayModel, "_home_break_sites", lambda *_: [])
    in_place = routes_of(plan)
    model = day_model({**raw, "initialRoutes": in_place})
    home = model.ctx.matrix.index_of(LatLng.model_validate(latlng(LAST_HOME)))
    assert home in [model.nodes[n].point for n in model.break_nodes[0]]
    keeps_every_trip({**raw, "initialRoutes": in_place})

    without_plan = day_model(raw)
    assert home not in [without_plan.nodes[n].point for n in without_plan.break_nodes[0]]


# --------------------------------------------------------------------------- break sites

FIRST_HOME = offset(SISTERON, -25, 10)
"""9 km off the way to LAST_HOME: alone, the last patient would be home 15 min earlier."""
LAST_HOME = offset(SISTERON, 0, 4)


def shared_lunchtime_returns() -> dict[str, Any]:
    """12/11 of the base seed, reduced: a Sisteron taxi takes two patients back from Marseille at
    10:55, the second dropoff ending a minute before the latest break start; the depot is minutes
    away. schedule.py rests on the way back; the solver needs the last home as a site, which the
    patient alone (home by 13:16 at the latest) did not make needed before OPT-09."""
    raw = request(
        [vehicle("taxi_sisteron", SISTERON, department="04", break_=LUNCH_BREAK)],
        [
            trip("first", "p1", "RETURN", MARSEILLE_FAC, FIRST_HOME, ready=655),
            trip("last", "p2", "RETURN", MARSEILLE_FAC, LAST_HOME, ready=655),
        ],
    )
    # The break window ends so that the last dropoff ends a minute before the latest break start.
    parsed = OptimizeRequest.model_validate(raw)
    ctx = make_context(parsed, build_matrix(request_points(parsed))[0])
    first, last = ctx.trips["first"], ctx.trips["last"]
    stops = [
        PlannedStop(
            t,
            kind,
            t.pickup if kind == "PICKUP" else t.dropoff,
            service_minutes(parsed.settings, t, kind),
            ctx.windows[t.id].for_kind(kind),
        )
        for t, kind in ((first, "PICKUP"), (last, "PICKUP"), (first, "DROPOFF"), (last, "DROPOFF"))
    ]
    ends = schedule_route(parsed.vehicles[0].model_copy(update={"break_": None}), stops, ctx.matrix).stops[-1].departure_min
    raw["vehicles"][0]["break"] = {**LUNCH_BREAK, "windowEndMin": ends + 1 + LUNCH_BREAK["durationMin"]}
    return raw


def test_a_shared_lunchtime_return_gets_its_last_home_as_a_break_site() -> None:
    raw = shared_lunchtime_returns()
    model = day_model(raw)
    home = model.ctx.matrix.index_of(LatLng.model_validate(latlng(LAST_HOME)))
    assert home in [model.nodes[n].point for n in model.break_nodes[0]]
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.validation.valid, plan.validation.violations[:5]
    assert plan.kpis.trips_served == 2
    assert plan.routes[0].break_ is not None


def far_outbound() -> dict[str, Any]:
    """A Sisteron taxi and a Gap patient due in Marseille in the afternoon: the ride covers the end
    of the break window, so the driver rests before the pickup, at Gap (the depot is 50 km away)."""
    home = offset(GAP, 1, 1)
    raw = request(
        [vehicle("taxi_sisteron", SISTERON, department="04", break_=LUNCH_BREAK)],
        [trip("far", "p1", "OUTBOUND", home, MARSEILLE_FAC, appointment=900)],
    )
    model = day_model(raw)
    pickup, delivery = (model.nodes[n] for n in model.trip_nodes["far"])
    # The latest pickup comes 2 min after the break at the home ends.
    ride = pickup.service_min + model._leg(pickup, delivery)
    raw["trips"][0]["appointmentMin"] = LUNCH_BREAK["windowStartMin"] + LUNCH_BREAK["durationMin"] + 2 + ride
    return raw


def test_a_long_outbound_gets_its_pickup_home_as_a_break_site() -> None:
    raw = far_outbound()
    model = day_model(raw)
    home = model.ctx.matrix.index_of(LatLng.model_validate(raw["trips"][0]["pickup"]))
    assert home in [model.nodes[n].point for n in model.break_nodes[0]]
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.validation.valid, plan.validation.violations[:5]
    assert plan.kpis.trips_served == 1


def test_time_rows_shared_by_alike_nodes_are_those_of_every_node() -> None:
    """_time_rows computes a row per kind of node and a value per kind of column: the same matrix
    as a cell by cell computation, with traffic bands and break nodes."""
    raw = busy_day(time_limit_sec=1)
    raw["settings"]["traffic"] = {
        "bands": [{"startMin": 420, "endMin": 570}, {"startMin": 570, "endMin": 960}],
        "roadFactors": [1.05, 1],
        "zones": [{"lat": MARSEILLE[0], "lng": MARSEILLE[1], "radiusKm": 14, "factors": [1.5, 1.2]}],
    }
    model = day_model(raw)
    assert any(node.role is solver.Role.BREAK for node in model.nodes)
    assert model._time_rows() == [[a.service_min + model._leg(a, b) for b in model.nodes] for a in model.nodes]


# --------------------------------------------------------------------------- trips left out


def test_the_final_check_places_the_trips_the_search_left_out() -> None:
    """From the breaks alone, as a search that placed nothing, the final check inserts the trips
    with its exact checks (the times schedule.py reports)."""
    model = day_model(generated_day())
    routes = model._breaks_only_routes()
    assert model.guarded(routes, NO_DEADLINE_SEC) == {}
    assert model._placed_in(routes) >= 55
    assert all(not model._scheduled_reasons(v, route) for v, route in enumerate(routes))
    assert model.routing.ReadAssignmentFromRoutes(routes, True) is not None


def two_taxis_one_slot() -> dict[str, Any]:
    """Two one-seat taxis. "free" (Aix, 10:00) fits either; "bound", locked on taxi_a, is due at
    the same time from the other side of Aix: with "free" on taxi_a, "bound" is left out until
    "free" moves to taxi_b."""
    facility = FACILITIES["fac_aix_ch"][1]
    trips = [
        trip("free", "p1", "OUTBOUND", offset(facility, 25, 0), facility, appointment=600),
        trip("bound", "p2", "OUTBOUND", offset(facility, -25, 0), facility, appointment=600, locked="taxi_a"),
    ]
    fleet = [vehicle("taxi_a", MARSEILLE, capacity=1), vehicle("taxi_b", MARSEILLE, capacity=1)]
    return request(fleet, trips)


def test_a_trip_left_out_takes_the_place_of_a_trip_that_moves_elsewhere() -> None:
    model = day_model(two_taxis_one_slot())
    bound, free = model.ctx.trips["bound"], model.ctx.trips["free"]
    on_a = model._cheapest_insertion([], 0, free)
    assert on_a is not None
    routes = [on_a[1], []]
    assert model._cheapest_insertion(routes[0], 0, bound) is None

    assert model.make_room(routes, NO_DEADLINE_SEC) == 1
    assert model._trip_ids(routes[0]) == ["bound"] and model._trip_ids(routes[1]) == ["free"]
    model._exact_checks = True
    assert all(model._fits(v, route) for v, route in enumerate(routes))

def test_the_final_check_puts_back_the_trips_it_took_out_before_the_others(monkeypatch: pytest.MonkeyPatch) -> None:
    """A locked trip the final check takes out goes back before a cheaper trip the search left out
    can take its slot (the regret insertion ranks by partner, regret and cost, not by lock): a
    one-seat taxi, two trips due at Aix at 10:00 that cannot be chained. Before the fix, "free" took
    the slot and "bound", locked, was left out: « Placer les non affectées » then lost a trip."""
    facility = FACILITIES["fac_aix_ch"][1]
    trips = [
        trip("bound", "p2", "OUTBOUND", offset(facility, 25, 0), facility, appointment=600, locked="taxi_a"),
        trip("free", "p1", "OUTBOUND", offset(facility, -25, 0), facility, appointment=600),
    ]
    model = day_model(request([vehicle("taxi_a", MARSEILLE, capacity=1)], trips))
    bound, free = model.ctx.trips["bound"], model.ctx.trips["free"]
    on_a = model._cheapest_insertion([], 0, bound)
    alone = model._cheapest_insertion([], 0, free)
    assert on_a is not None and alone is not None and alone[0] < on_a[0]
    assert model._cheapest_insertion(on_a[1], 0, free) is None
    routes = [on_a[1]]
    # The final check finds "bound" breaking a rule once, as a timing only schedule.py sees would.
    breach = iter([{"bound": solver.REASON_DROPPED_ON_BOARD}])
    exact = solver._DayModel._scheduled_reasons
    monkeypatch.setattr(solver._DayModel, "_scheduled_reasons", lambda self, v, seq: next(breach, None) or exact(self, v, seq))
    assert model.guarded(routes, NO_DEADLINE_SEC) == {}
    assert model._trip_ids(routes[0]) == ["bound"]


def two_ambulances_busy() -> dict[str, Any]:
    """Two ambulances, each with a patient at 11:00; a third patient ready at 11:00 has no room."""
    facility = FACILITIES["fac_marseille_nord"][1]
    trips = [
        trip(f"t{n}", f"p{n}", "RETURN", facility, offset(facility, 6 + n, 1), ready=660, types=("AMBULANCE",), shareable=False)
        for n in range(3)
    ]
    fleet = [vehicle("amb_1", MARSEILLE, type_="AMBULANCE"), vehicle("amb_2", MARSEILLE, type_="AMBULANCE")]
    return request(fleet, trips, timeLimitSec=2)


def test_a_trip_left_out_says_what_keeps_each_compatible_vehicle_from_taking_it() -> None:
    plan = service.optimize(OptimizeRequest.model_validate(two_ambulances_busy()))
    assert plan.kpis.trips_served == 2
    [left] = plan.unassigned
    assert left.reason.startswith(f"{solver.REASON_DROPPED_PREFIX} 11:00 à ")
    assert f"{NBSP}: Amb 1 transporte un autre patient de 11:" in left.reason
    assert f"{NBSP}; Amb 2 transporte un autre patient de 11:" in left.reason


def test_a_trip_left_out_counts_the_vehicles_when_there_are_many() -> None:
    raw = two_ambulances_busy()
    raw["vehicles"] = [vehicle(f"amb_{n}", MARSEILLE, type_="AMBULANCE") for n in range(1, 5)]
    facility = FACILITIES["fac_marseille_nord"][1]
    raw["trips"] = [
        trip(f"t{n}", f"p{n}", "RETURN", facility, offset(facility, 6 + n, 1), ready=660, types=("AMBULANCE",), shareable=False)
        for n in range(5)
    ]
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.kpis.trips_served == 4
    [left] = plan.unassigned
    assert left.reason.endswith(f"{NBSP}: les 4 véhicules compatibles transportent d'autres patients")


def seed_small_place_day() -> dict[str, Any]:
    with gzip.open(SEED_SMALL_PLACE_DAY, "rt", encoding="utf-8") as file:
        raw: dict[str, Any] = json.load(file)
    raw["settings"]["timeLimitSec"] = 2
    return raw


def left_out_reason_of(raw: dict[str, Any], trip_id: str) -> str:
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.validation.valid, plan.validation.violations[:5]
    return next(u.reason for u in plan.unassigned if u.trip_id == trip_id)


def test_the_reason_names_what_keeps_each_ambulance_away_not_what_it_does_meanwhile() -> None:
    """12/11 of the small seed, « Placer les non affectées »: no ambulance can take the 11:30
    return. Ambulance 2 is in Gap, 180 km away, with a locked trip at 13:16 there: it was said to
    be « en pause de 11:30 à 12:15 », although it cannot take the trip without its break either.
    Ambulance 1 needs both its 13:00 and 13:30 trips in Aix out of the way: neither alone, nor its
    break, is the cause."""
    reason = left_out_reason_of(seed_small_place_day(), AMBULANCE_RETURN)
    assert reason == (
        f"{solver.REASON_DROPPED_PREFIX} 11:30 à 11:54{NBSP}: "
        f"Ambulance 1 (Marseille) ne peut pas l'intercaler entre ses arrêts de 10:55 et 12:31{NBSP}; "
        "Ambulance 2 (Gap) ne peut pas rejoindre ensuite son arrêt de 13:16"
    )


def test_the_reason_of_a_locked_trip_does_not_name_its_vehicle_again() -> None:
    """The web says which vehicle refused the move around the reason (move.ts)."""
    raw = seed_small_place_day()
    next(t for t in raw["trips"] if t["id"] == AMBULANCE_RETURN)["lockedVehicleId"] = AMBULANCE_GAP
    reason = left_out_reason_of(raw, AMBULANCE_RETURN)
    assert reason == (
        f"{solver.REASON_DROPPED_PREFIX} 11:30 à 11:54{NBSP}: le véhicule figé ne peut pas rejoindre ensuite son arrêt de 13:16"
    )


def break_in_the_way() -> dict[str, Any]:
    """A one-seat taxi drops a patient at the Timone at 12:15, when another one is ready to go home
    from there, and takes a third there for 13:45: its driver's 45 min break, due to start between
    11:30 and 13:15, fits between the first two trips only."""
    rule = {"windowStartMin": 690, "windowEndMin": 840, "durationMin": 45}
    return request(
        [vehicle("taxi_a", MARSEILLE, capacity=1, break_=rule)],
        [
            trip("a", "p1", "OUTBOUND", offset(MARSEILLE_FAC, 4, 2), MARSEILLE_FAC, appointment=735),
            trip("t", "p2", "RETURN", MARSEILLE_FAC, offset(MARSEILLE_FAC, -4, 2), ready=735),
            trip("b", "p3", "OUTBOUND", offset(MARSEILLE_FAC, 4, -2), MARSEILLE_FAC, appointment=825),
        ],
    )


def test_a_break_is_named_when_the_trip_fits_without_it() -> None:
    model = day_model(break_in_the_way())
    model._exact_checks = True
    route = model._breaks_only_routes()[0]
    for trip_id in ("a", "b"):
        fit = model._cheapest_insertion(route, 0, model.ctx.trips[trip_id])
        assert fit is not None
        route = fit[1]
    t = model.ctx.trips["t"]
    assert model._cheapest_insertion(route, 0, t) is None
    assert model._fits_without_break(0, route, t)
    reason = model.left_out_reason(t, [route], {}, time.monotonic() + NO_DEADLINE_SEC)
    assert reason.endswith(f"{NBSP}: Taxi A est en pause de 12:02 à 12:47"), reason


def test_a_shared_ride_that_does_not_fit_is_not_called_a_full_vehicle() -> None:
    """Two patients ready at 11:00, going home 12 km apart on either side: the taxi has a free seat,
    the detour is what keeps it from taking the second one."""
    raw = request(
        [vehicle("taxi_a", MARSEILLE)],
        [
            trip("east", "p1", "RETURN", MARSEILLE_FAC, offset(MARSEILLE_FAC, 0, 6), ready=660),
            trip("west", "p2", "RETURN", MARSEILLE_FAC, offset(MARSEILLE_FAC, 0, -6), ready=660),
        ],
        timeLimitSec=2,
    )
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    assert plan.kpis.trips_served == 1
    [left] = plan.unassigned
    assert f"{NBSP}: Taxi A ne peut pas la partager avec son patient de 11:00 à 11:" in left.reason, left.reason
    assert left.reason.endswith(" (détour ou horaires)")


def test_no_driver_can_take_the_trip_with_their_break() -> None:
    """A long outbound whose ride covers the break window: no driver can rest before nor after it,
    whatever the plan; the reason says what the regulator can do."""
    raw = far_outbound()
    raw["vehicles"].append(vehicle("taxi_gap", GAP, department="05", break_=LUNCH_BREAK))
    model = day_model(raw)
    pickup, delivery = (model.nodes[n] for n in model.trip_nodes["far"])
    # The latest pickup comes 5 min before the earliest end of a break.
    ride = pickup.service_min + model._leg(pickup, delivery)
    raw["trips"][0]["appointmentMin"] = LUNCH_BREAK["windowStartMin"] + LUNCH_BREAK["durationMin"] - 5 + ride
    plan = service.optimize(OptimizeRequest.model_validate(raw))
    [left] = plan.unassigned
    assert left.reason.endswith(
        f"{NBSP}: aucun des 2 véhicules compatibles ne peut l'assurer avec la pause de son chauffeur, "
        f"même sans autre course{NBSP}: {solver.ALONE_ADVICE}"
    ), left.reason


def test_the_reason_only_gives_the_times_when_time_runs_out() -> None:
    raw = two_ambulances_busy()
    model = day_model(raw)
    routes = model._breaks_only_routes()
    reason = model.left_out_reason(model.ctx.trips["t0"], routes, {}, time.monotonic() - 1)
    assert reason.startswith(f"{solver.REASON_DROPPED_PREFIX} 11:00 à 11:")
    assert reason.endswith(f"{NBSP}: {solver.REASON_DROPPED_DETAIL}")
