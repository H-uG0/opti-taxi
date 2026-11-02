"""Travel matrix: straight-line estimate, deduplication, OSRM table (mocked) and fallback."""

from __future__ import annotations

import math

import httpx
import pytest

from app.matrix import (
    ROAD_FACTOR,
    build_matrix,
    great_circle_km,
    osrm_matrix,
    point_key,
    straight_line_minutes,
    straight_line_road_km,
)
from app.schemas import LatLng
from tests.builders import AIX, GAP, MARSEILLE

MRS = LatLng(lat=MARSEILLE[0], lng=MARSEILLE[1])
AIX_P = LatLng(lat=AIX[0], lng=AIX[1])
GAP_P = LatLng(lat=GAP[0], lng=GAP[1])


def test_great_circle_marseille_aix_is_about_26_km() -> None:
    assert great_circle_km(MARSEILLE, AIX) == pytest.approx(26.7, abs=0.5)


def test_road_km_is_great_circle_times_factor() -> None:
    assert straight_line_road_km(MARSEILLE, AIX) == pytest.approx(great_circle_km(MARSEILLE, AIX) * ROAD_FACTOR)
    assert straight_line_road_km(MARSEILLE, MARSEILLE) == 0.0


@pytest.mark.parametrize(
    ("km", "minutes"),
    [(0, 0), (0.01, 1), (5, 10), (10, 20), (95, 80), (52.5, 50)],
)
def test_minutes_urban_then_road_speed_rounded_up(km: float, minutes: int) -> None:
    assert straight_line_minutes(km) == minutes


def test_haversine_matrix_is_deterministic_symmetric_and_deduplicated() -> None:
    points = [MRS, AIX_P, MRS, GAP_P, LatLng(lat=MARSEILLE[0], lng=MARSEILLE[1])]
    matrix, warnings = build_matrix(points)
    assert warnings == []
    assert matrix.source == "haversine"
    assert len(matrix.points) == 3
    assert matrix.minutes(MRS, MRS) == 0 and matrix.km(MRS, MRS) == 0
    assert matrix.km(MRS, AIX_P) == pytest.approx(matrix.km(AIX_P, MRS))
    assert matrix.minutes(MRS, GAP_P) == straight_line_minutes(matrix.km(MRS, GAP_P))
    again, _ = build_matrix(points)
    assert again.minutes_table == matrix.minutes_table and again.km_table == matrix.km_table


def _osrm_handler(calls: list[httpx.Request]) -> httpx.MockTransport:
    """Fake OSRM: duration = 60 s per km of straight line, distance = 1000 m per km."""

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        coords = request.url.path.split("/driving/")[1].split(";")
        points = [(float(c.split(",")[1]), float(c.split(",")[0])) for c in coords]
        sources = [int(i) for i in request.url.params["sources"].split(";")]
        destinations = [int(i) for i in request.url.params["destinations"].split(";")]
        km = [[straight_line_road_km(points[s], points[d]) for d in destinations] for s in sources]
        return httpx.Response(
            200,
            json={
                "code": "Ok",
                "durations": [[k * 60 for k in row] for row in km],
                "distances": [[k * 1000 for k in row] for row in km],
            },
        )

    return httpx.MockTransport(handle)


def test_osrm_matrix_is_requested_by_blocks() -> None:
    calls: list[httpx.Request] = []
    keys = [point_key(p) for p in (MRS, AIX_P, GAP_P)]
    matrix, unrouted = osrm_matrix(keys, "http://osrm.test", transport=_osrm_handler(calls), chunk=2)
    assert unrouted == 0
    assert len(calls) == 4  # 2 source blocks x 2 destination blocks
    assert matrix.source == "osrm"
    expected_km = straight_line_road_km(MARSEILLE, GAP)
    assert matrix.km(MRS, GAP_P) == pytest.approx(expected_km)
    assert matrix.minutes(MRS, GAP_P) == math.ceil(expected_km - 1e-9)
    assert matrix.minutes(GAP_P, GAP_P) == 0


def test_build_matrix_uses_osrm_when_configured() -> None:
    calls: list[httpx.Request] = []
    matrix, warnings = build_matrix([MRS, AIX_P], "http://osrm.test/", transport=_osrm_handler(calls))
    assert matrix.source == "osrm" and warnings == []
    assert calls and calls[0].url.params["annotations"] == "duration,distance"
    assert b"sources=0;1&destinations=0;1" in calls[0].url.query  # literal separators, as OSRM documents
    assert calls[0].url.path.startswith("/table/v1/driving/5.369800,43.296500;")


def test_osrm_failure_falls_back_to_straight_line_with_warning() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    matrix, warnings = build_matrix([MRS, AIX_P], "http://osrm.test", transport=httpx.MockTransport(broken))
    assert matrix.source == "haversine"
    assert len(warnings) == 1 and "OSRM indisponible" in warnings[0]


def test_osrm_unreachable_server_falls_back() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    matrix, warnings = build_matrix([MRS, AIX_P], "http://osrm.test", transport=httpx.MockTransport(refuse))
    assert matrix.source == "haversine" and warnings


def test_osrm_unroutable_pairs_use_straight_line() -> None:
    def partial(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": "Ok", "durations": [[0, None], [600, 0]], "distances": [[0, None], [9000, 0]]})

    matrix, warnings = build_matrix([MRS, AIX_P], "http://osrm.test", transport=httpx.MockTransport(partial))
    assert matrix.source == "osrm"
    assert matrix.km(AIX_P, MRS) == pytest.approx(9.0) and matrix.minutes(AIX_P, MRS) == 10
    assert matrix.km(MRS, AIX_P) == pytest.approx(straight_line_road_km(MARSEILLE, AIX))
    assert any("introuvable" in w for w in warnings)
