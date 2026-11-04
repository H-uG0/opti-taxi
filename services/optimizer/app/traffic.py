"""Traffic: the travel times of each time band of the day.

The solver works on a fixed table of arcs, so travel times cannot depend on the exact time a leg is
driven. They depend instead on the reference minutes of its two ends (`stop_reference_minute`),
known before solving: the appointment or the end of session of the trip. A stop stays close to its
reference (at most the wait allowed at the facility), and a leg takes the slower band of its two
ends, so the band can only be wrong right next to a band edge.

A `TrafficProvider` fills one minutes table per band; nothing else knows how:

- `ZoneFactors` (settings.traffic): free-flow minutes slowed down by a factor per zone and per band,
  on the part of the leg driven inside the zone. Needs no third party: no coordinate leaves the
  service.
- A traffic-aware matrix API would be another provider: one matrix per band, requested at a departure
  time inside it. It would add its name to `TrafficSource` in the contract and fall back on
  `ZoneFactors` when the API fails, as the matrix falls back on the straight-line estimate. Patients'
  home coordinates would then reach a third party: to be cleared first (GDPR, HDS).
"""

from __future__ import annotations

import dataclasses
import math
from typing import Protocol

from app.matrix import ROAD_FACTOR, URBAN_SPEED_KMH, MinutesTable, PointKey, TrafficTables, TravelMatrix
from app.schemas import StopKind, TrafficSettings, TrafficSource, TrafficZone, Trip

EARTH_KM_PER_DEGREE = math.pi * 6371.0 / 180


class TrafficProvider(Protocol):
    source: TrafficSource

    def tables(self, matrix: TravelMatrix, traffic: TrafficSettings) -> tuple[MinutesTable, ...]:
        """One minutes table per band of `traffic`, indexed like `matrix`."""
        ...


def _km_inside(a: PointKey, b: PointKey, zone: TrafficZone) -> float:
    """Length (km) of the straight segment a-b inside the circle of the zone (flat earth around the
    zone's center: fine at the scale of a city)."""
    x_scale = EARTH_KM_PER_DEGREE * math.cos(math.radians(zone.lat))
    ax, ay = (a[1] - zone.lng) * x_scale, (a[0] - zone.lat) * EARTH_KM_PER_DEGREE
    dx, dy = (b[1] - zone.lng) * x_scale - ax, (b[0] - zone.lat) * EARTH_KM_PER_DEGREE - ay
    squared = dx * dx + dy * dy
    if squared == 0:
        return 0.0
    half_b = ax * dx + ay * dy
    discriminant = half_b * half_b - squared * (ax * ax + ay * ay - zone.radius_km * zone.radius_km)
    if discriminant <= 0:
        return 0.0
    root = math.sqrt(discriminant)
    enter, leave = max((-half_b - root) / squared, 0.0), min((-half_b + root) / squared, 1.0)
    return max(leave - enter, 0.0) * math.sqrt(squared)


def _zone_minutes(km_inside: float, free_flow: int) -> float:
    """Free-flow minutes spent inside a zone: road km at urban speed, never more than the whole leg."""
    return min(km_inside * ROAD_FACTOR / URBAN_SPEED_KMH * 60, float(free_flow))


class ZoneFactors:
    """Free-flow minutes, slowed down by the factor of each zone on the time spent inside it, and by
    the road factor on the rest of the leg."""

    source: TrafficSource = "factors"

    def tables(self, matrix: TravelMatrix, traffic: TrafficSettings) -> tuple[MinutesTable, ...]:
        points = matrix.points
        free_flow = matrix.minutes_table
        # Minutes inside each zone per pair: the same whatever the band.
        inside: list[list[list[float]]] = [
            [[_zone_minutes(_km_inside(a, b, zone), free_flow[i][j]) for j, b in enumerate(points)] for i, a in enumerate(points)]
            for zone in traffic.zones
        ]
        tables: list[MinutesTable] = []
        for band in range(len(traffic.bands)):
            road = traffic.road_factors[band]
            extras = [zone.factors[band] - 1 for zone in traffic.zones]
            rows: list[tuple[int, ...]] = []
            for i in range(len(points)):
                row: list[int] = []
                for j in range(len(points)):
                    base = free_flow[i][j]
                    in_zones = [minutes[i][j] for minutes in inside]
                    total = sum(in_zones)
                    # Zones are not meant to overlap: if they do, a leg still counts no more minutes than it lasts.
                    scale = base / total if total > base else 1.0
                    added = sum(share * scale * extra for share, extra in zip(in_zones, extras, strict=True))
                    added += max(base - total, 0.0) * (road - 1)
                    row.append(math.ceil(base + added - 1e-9))
                rows.append(tuple(row))
            tables.append(tuple(rows))
        return tuple(tables)


def with_traffic(matrix: TravelMatrix, traffic: TrafficSettings | None, provider: TrafficProvider | None = None) -> TravelMatrix:
    """The matrix with the tables of each time band; unchanged without traffic settings."""
    if traffic is None:
        return matrix
    provider = provider or ZoneFactors()
    tables = TrafficTables(
        source=provider.source,
        bands=tuple((band.start_min, band.end_min) for band in traffic.bands),
        tables=provider.tables(matrix, traffic),
    )
    return dataclasses.replace(matrix, traffic=tables)


def stop_reference_minute(trip: Trip, kind: StopKind, matrix: TravelMatrix) -> int:
    """Minute a stop is expected around, from what is known before solving: an outbound trip works
    back from its appointment, a return trip forward from its end of session."""
    ride = matrix.minutes(trip.pickup, trip.dropoff)
    if trip.direction == "OUTBOUND":
        appointment = trip.appointment_min or 0
        return appointment if kind == "DROPOFF" else max(0, appointment - ride)
    ready = trip.ready_min or 0
    return ready if kind == "PICKUP" else ready + ride
