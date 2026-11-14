"""A day under way (contract `progress`, README « Journée commencée »): where and when each vehicle
goes on, and which patients it carries.

- The stops done (`progress.routes[].done`) never change: every plan returned starts each started
  route with them, at their real times, and nothing still to do is planned before them.
- A started vehicle goes on from the place of its last stop done, at the latest of the request's
  minute (`nowMin`), the end of that stop and the end of a break taken; a vehicle without a stop done
  leaves its depot at the latest of its shift start and `nowMin`.
- A trip picked up and not yet dropped off is on board: its dropoff stays on that vehicle, first come
  of its remaining stops or later, and is never left out (README: a patient on board is always
  dropped, even late). Its time on board and its detour count from its real pickup.

Pure: computed once per request (context.make_context) from the request and the travel matrix.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field

from app.schemas import DayRequest, DoneStop, LatLng, StopKind, StopRef, Trip, Vehicle


@dataclass(frozen=True)
class VehicleStart:
    """Where and when a vehicle goes on, on a day under way."""

    vehicle_id: str
    done: tuple[DoneStop, ...]
    """Its stops done, in route order: the head of every route it is given."""
    location: LatLng
    """Place of its last stop done, its depot without one."""
    min: int
    """Earliest minute it leaves `location` for its next stop."""
    on_board: tuple[str, ...]
    """Trips picked up and not dropped off, in pickup order."""
    break_taken: tuple[int, int] | None
    """The driver's break already taken (or under way): no other is placed."""
    day_start: int | None = None
    """Departure of the whole route from the depot (before its first stop done): its work time counts from it."""

    @property
    def started(self) -> bool:
        return bool(self.done)

    def done_refs(self) -> list[StopRef]:
        return [StopRef(trip_id=stop.trip_id, kind=stop.kind) for stop in self.done]


@dataclass(frozen=True)
class DayProgress:
    """The progress of a request (empty for a day not started)."""

    now_min: int | None = None
    starts: Mapping[str, VehicleStart] = field(default_factory=dict)
    """Started vehicles (a stop done), by id."""
    on_board: Mapping[str, str] = field(default_factory=dict)
    """Trip on board -> its vehicle."""
    done_trips: frozenset[str] = frozenset()
    """Trips whose pickup and dropoff are both done."""
    done_stops: frozenset[tuple[str, StopKind]] = frozenset()
    ride_km_so_far: Mapping[str, float] = field(default_factory=dict)
    """Km driven so far with each patient on board (from their pickup to the last stop done)."""

    @property
    def active(self) -> bool:
        return self.now_min is not None

    def start_of(self, vehicle: Vehicle) -> VehicleStart | None:
        """The start of `vehicle` on a day under way (its depot when nothing is done), None otherwise."""
        if self.now_min is None:
            return None
        started = self.starts.get(vehicle.id)
        if started is not None:
            return started
        return VehicleStart(vehicle.id, (), vehicle.depot, max(vehicle.shift_start_min, self.now_min), (), None)

    def is_on_board(self, trip_id: str) -> bool:
        return trip_id in self.on_board

    def is_done(self, trip_id: str, kind: StopKind) -> bool:
        return (trip_id, kind) in self.done_stops

    def is_fixed(self, trip_id: str) -> bool:
        """A trip the planning no longer moves: done, or on board (its dropoff stays on its vehicle)."""
        return trip_id in self.done_trips or trip_id in self.on_board

    def with_done(self, sequences: Mapping[str, Sequence[StopRef]], *, every_started: bool = True) -> dict[str, list[StopRef]]:
        """Each started route headed by its stops done, then the stops given for it that are not done
        (a stop done given elsewhere is dropped); with `every_started`, the started vehicles given no
        stop keep their stops done (a whole day). Without progress, the sequences as given."""
        if not self.done_stops:
            return {vehicle_id: list(refs) for vehicle_id, refs in sequences.items()}
        result: dict[str, list[StopRef]] = {}
        for vehicle_id, refs in sequences.items():
            rest = [ref for ref in refs if (ref.trip_id, ref.kind) not in self.done_stops]
            start = self.starts.get(vehicle_id)
            result[vehicle_id] = [*(start.done_refs() if start else ()), *rest]
        for vehicle_id, start in self.starts.items():
            if every_started and vehicle_id not in result:
                result[vehicle_id] = start.done_refs()
        return {vehicle_id: refs for vehicle_id, refs in result.items() if refs}


NO_PROGRESS = DayProgress()


def _location(trip: Trip, kind: StopKind) -> LatLng:
    return trip.pickup if kind == "PICKUP" else trip.dropoff


def derive_progress(
    request: DayRequest,
    km: Callable[[LatLng, LatLng], float],
    first_leg: Callable[[LatLng, Trip, StopKind], int] | None = None,
) -> DayProgress:
    """The starts of a request's vehicles from its `progress` (NO_PROGRESS without it). `first_leg`: minutes from
    a depot to a stop (the route's start before its first stop done)."""
    progress = request.progress
    if progress is None:
        return NO_PROGRESS
    trips = {trip.id: trip for trip in request.trips}
    vehicles = {vehicle.id: vehicle for vehicle in request.vehicles}
    starts: dict[str, VehicleStart] = {}
    on_board: dict[str, str] = {}
    done_trips: set[str] = set()
    done_stops: set[tuple[str, StopKind]] = set()
    ride_km: dict[str, float] = {}
    for route in progress.routes:
        vehicle = vehicles[route.vehicle_id]
        boarded: dict[str, float] = {}
        previous: LatLng | None = None
        for stop in route.done:
            trip = trips[stop.trip_id]
            here = _location(trip, stop.kind)
            if previous is not None:
                step = km(previous, here)
                for trip_id in boarded:
                    boarded[trip_id] += step
            previous = here
            done_stops.add((stop.trip_id, stop.kind))
            if stop.kind == "PICKUP":
                boarded[stop.trip_id] = 0.0
            else:
                boarded.pop(stop.trip_id, None)
                done_trips.add(stop.trip_id)
        if not route.done:
            continue
        last = route.done[-1]
        taken = (route.break_taken.start_min, route.break_taken.end_min) if route.break_taken else None
        # With patients on board the vehicle has driven on since its last stop done (no position is known):
        # it goes on from there at that time. Empty, it waits there until now.
        moving = last.departure_min if boarded else max(progress.now_min, last.departure_min)
        minute = max(moving, taken[1] if taken else 0)
        first = route.done[0]
        day_start = first.start_min - first_leg(vehicle.depot, trips[first.trip_id], first.kind) if first_leg else None
        for trip_id, ridden in boarded.items():
            on_board[trip_id] = vehicle.id
            ride_km[trip_id] = ridden
        starts[vehicle.id] = VehicleStart(
            vehicle_id=vehicle.id,
            done=tuple(route.done),
            location=_location(trips[last.trip_id], last.kind),
            min=minute,
            on_board=tuple(boarded),
            break_taken=taken,
            day_start=day_start,
        )
    return DayProgress(
        now_min=progress.now_min,
        starts=starts,
        on_board=on_board,
        done_trips=frozenset(done_trips),
        done_stops=frozenset(done_stops),
        ride_km_so_far=ride_km,
    )

