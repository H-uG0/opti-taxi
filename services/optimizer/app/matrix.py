"""Travel times and distances between the points of a planning day.

Two providers fill the same `TravelMatrix`:

- straight-line estimate (deterministic): road km = great-circle km x 1.3, minutes at 30 km/h for
  the first 10 km then 85 km/h, rounded up to a whole minute;
- OSRM (`OSRM_URL` set): road times and distances from the `table` service, requested by blocks
  when there are many points. Any OSRM failure falls back to the straight-line estimate and adds a
  warning, so planning never fails because the routing server is down.

Identical coordinates are deduplicated: the matrix is indexed by distinct points.
"""

from __future__ import annotations

import math
import os
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

import httpx

from app.schemas import LatLng, MatrixSource

ROAD_FACTOR = 1.3
URBAN_KM = 10.0
URBAN_SPEED_KMH = 30.0
ROAD_SPEED_KMH = 85.0
EARTH_RADIUS_KM = 6371.0
COORD_DECIMALS = 6

OSRM_TIMEOUT_SEC = 10.0
OSRM_CHUNK = 100
"""Points per side of one OSRM table request (sources x destinations)."""

PointKey = tuple[float, float]


def point_key(point: LatLng) -> PointKey:
    """Hashable identity of a coordinate (rounded to ~0.1 m)."""
    return (round(point.lat, COORD_DECIMALS), round(point.lng, COORD_DECIMALS))


def great_circle_km(a: PointKey, b: PointKey) -> float:
    """Haversine distance in km between two (lat, lng) pairs."""
    lat1, lng1 = math.radians(a[0]), math.radians(a[1])
    lat2, lng2 = math.radians(b[0]), math.radians(b[1])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(h)))


def straight_line_road_km(a: PointKey, b: PointKey) -> float:
    """Estimated road distance: great-circle distance x 1.3."""
    if a == b:
        return 0.0
    return great_circle_km(a, b) * ROAD_FACTOR


def straight_line_minutes(road_km: float) -> int:
    """Estimated driving minutes for a road distance (urban speed first, then road speed), rounded up."""
    if road_km <= 0:
        return 0
    minutes = min(road_km, URBAN_KM) / URBAN_SPEED_KMH * 60 + max(road_km - URBAN_KM, 0.0) / ROAD_SPEED_KMH * 60
    return math.ceil(minutes - 1e-9)


@dataclass(frozen=True)
class TravelMatrix:
    """Minutes and km between distinct points, plus the provider that produced them."""

    points: tuple[PointKey, ...]
    minutes_table: tuple[tuple[int, ...], ...]
    km_table: tuple[tuple[float, ...], ...]
    source: MatrixSource
    _index: dict[PointKey, int] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_index", {key: i for i, key in enumerate(self.points)})

    def index_of(self, point: LatLng | PointKey) -> int:
        """Row/column of a point; raises KeyError for a point the matrix was not built with."""
        key = point if isinstance(point, tuple) else point_key(point)
        return self._index[key]

    def minutes(self, a: LatLng, b: LatLng) -> int:
        return self.minutes_table[self.index_of(a)][self.index_of(b)]

    def km(self, a: LatLng, b: LatLng) -> float:
        return self.km_table[self.index_of(a)][self.index_of(b)]

    def minutes_by_index(self, i: int, j: int) -> int:
        return self.minutes_table[i][j]

    def km_by_index(self, i: int, j: int) -> float:
        return self.km_table[i][j]


def distinct_points(points: Iterable[LatLng]) -> list[PointKey]:
    """Distinct coordinates in first-seen order."""
    seen: dict[PointKey, None] = {}
    for point in points:
        seen.setdefault(point_key(point), None)
    return list(seen)


def haversine_matrix(keys: Sequence[PointKey]) -> TravelMatrix:
    """Straight-line matrix over distinct points."""
    km_rows: list[tuple[float, ...]] = []
    minute_rows: list[tuple[int, ...]] = []
    for a in keys:
        km_row = tuple(straight_line_road_km(a, b) for b in keys)
        km_rows.append(km_row)
        minute_rows.append(tuple(straight_line_minutes(km) for km in km_row))
    return TravelMatrix(tuple(keys), tuple(minute_rows), tuple(km_rows), "haversine")


class OsrmError(RuntimeError):
    """OSRM answered, but not with a usable table."""


def _blocks(size: int, chunk: int) -> list[range]:
    return [range(start, min(start + chunk, size)) for start in range(0, size, chunk)]


def _fetch_block(
    client: httpx.Client, base_url: str, keys: Sequence[PointKey], sources: range, destinations: range
) -> tuple[list[list[float | None]], list[list[float | None]]]:
    """One OSRM table request: durations (s) and distances (m) from `sources` to `destinations`."""
    union = list(dict.fromkeys([*sources, *destinations]))
    position = {point: i for i, point in enumerate(union)}
    coordinates = ";".join(f"{keys[i][1]:.6f},{keys[i][0]:.6f}" for i in union)
    # Built by hand: OSRM documents literal ";" and "," separators in the query string.
    query = "annotations=duration,distance&sources={}&destinations={}".format(
        ";".join(str(position[i]) for i in sources),
        ";".join(str(position[i]) for i in destinations),
    )
    response = client.get(f"{base_url}/table/v1/driving/{coordinates}?{query}")
    response.raise_for_status()
    body = response.json()
    if not isinstance(body, dict) or body.get("code") != "Ok":
        code = body.get("code") if isinstance(body, dict) else "?"
        raise OsrmError(f"réponse OSRM {code}")
    durations = body.get("durations")
    distances = body.get("distances")
    if not isinstance(durations, list) or not isinstance(distances, list):
        raise OsrmError("réponse OSRM sans durées ni distances")
    if len(durations) != len(sources) or len(distances) != len(sources):
        raise OsrmError("réponse OSRM de taille inattendue")
    for row_d, row_m in zip(durations, distances, strict=True):
        if not isinstance(row_d, list) or not isinstance(row_m, list):
            raise OsrmError("réponse OSRM mal formée")
        if len(row_d) != len(destinations) or len(row_m) != len(destinations):
            raise OsrmError("réponse OSRM de taille inattendue")
    return durations, distances


def osrm_matrix(
    keys: Sequence[PointKey],
    base_url: str,
    *,
    transport: httpx.BaseTransport | None = None,
    chunk: int = OSRM_CHUNK,
) -> tuple[TravelMatrix, int]:
    """Road matrix from OSRM. Returns the matrix and the number of pairs OSRM could not route
    (those pairs use the straight-line estimate)."""
    size = len(keys)
    km_rows = [[0.0] * size for _ in range(size)]
    minute_rows = [[0] * size for _ in range(size)]
    unrouted = 0
    with httpx.Client(timeout=OSRM_TIMEOUT_SEC, transport=transport) as client:
        for sources in _blocks(size, chunk):
            for destinations in _blocks(size, chunk):
                durations, distances = _fetch_block(client, base_url.rstrip("/"), keys, sources, destinations)
                for r, i in enumerate(sources):
                    for c, j in enumerate(destinations):
                        if i == j:
                            continue
                        seconds, meters = durations[r][c], distances[r][c]
                        if not isinstance(seconds, int | float) or not isinstance(meters, int | float):
                            unrouted += 1
                            km = straight_line_road_km(keys[i], keys[j])
                            km_rows[i][j], minute_rows[i][j] = km, straight_line_minutes(km)
                            continue
                        km_rows[i][j] = float(meters) / 1000.0
                        minute_rows[i][j] = max(0, math.ceil(float(seconds) / 60.0 - 1e-9))
    matrix = TravelMatrix(
        tuple(keys),
        tuple(tuple(row) for row in minute_rows),
        tuple(tuple(row) for row in km_rows),
        "osrm",
    )
    return matrix, unrouted


def configured_osrm_url() -> str | None:
    """OSRM base URL from the environment, None when the straight-line estimate is used."""
    url = os.environ.get("OSRM_URL", "").strip()
    return url or None


def build_matrix(
    points: Iterable[LatLng],
    osrm_url: str | None = None,
    *,
    transport: httpx.BaseTransport | None = None,
) -> tuple[TravelMatrix, list[str]]:
    """Matrix over the distinct points, from OSRM when configured, else straight-line.

    Returns the matrix and French warnings for the regulator (OSRM down, unroutable pairs).
    """
    keys = distinct_points(points)
    warnings: list[str] = []
    if osrm_url and len(keys) <= 1:
        trivial = haversine_matrix(keys)
        return TravelMatrix(trivial.points, trivial.minutes_table, trivial.km_table, "osrm"), warnings
    if osrm_url:
        try:
            matrix, unrouted = osrm_matrix(keys, osrm_url, transport=transport)
        except (httpx.HTTPError, OsrmError, ValueError, TypeError, KeyError) as error:
            warnings.append(
                f"OSRM indisponible ({type(error).__name__}: {error}) : temps et distances estimés à vol d'oiseau"
            )
        else:
            if unrouted:
                warnings.append(
                    f"{unrouted} trajet(s) introuvable(s) dans OSRM : estimation à vol d'oiseau pour ces trajets"
                )
            return matrix, warnings
    return haversine_matrix(keys), warnings
