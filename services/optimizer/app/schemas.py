"""Wire contract between the web app and the optimizer (v1).

Mirror of apps/web/src/lib/optimizer/contract.ts. Both must accept every file in
contract/fixtures. See contract/README.md for field semantics and units:
times are integer minutes since local midnight, distances km, money euros.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

VehicleType = Literal["TAXI", "VSL", "AMBULANCE"]
Direction = Literal["OUTBOUND", "RETURN"]
StopKind = Literal["PICKUP", "DROPOFF"]
PlanStatus = Literal["OK", "NO_SOLUTION"]
MatrixSource = Literal["osrm", "haversine"]
TrafficSource = Literal["none", "factors"]
ViolationCode = Literal[
    "UNKNOWN_REFERENCE",
    "DUPLICATE_TRIP",
    "PAIRING",
    "LOCK",
    "VEHICLE_TYPE",
    "CAPACITY",
    "EXCLUSIVE_RIDE",
    "TIME_WINDOW",
    "TOTAL_WAIT",
    "RIDE_TIME",
    "DETOUR",
    "SHIFT",
    "BREAK",
]

MINUTES_PER_DAY = 24 * 60
DayMinute = Annotated[int, Field(ge=0, le=2 * MINUTES_PER_DAY)]
ServiceMinutes = Annotated[int, Field(ge=0, le=120)]
"""Stop duration of one trip (contract Trip.pickupServiceMin / dropoffServiceMin)."""
DEFAULT_MAX_RIDE_EXTRA_MIN = 30
"""Settings.maxRideExtraMin when the request leaves it out (same default in contract.ts)."""

# Bounds of a request (a 120-vehicle day is about 1 000 trips): beyond, 422 before any work.
# Same values in contract.ts (MAX_VEHICLES, MAX_TRIPS, MAX_TARIFFS).
MAX_VEHICLES = 300
MAX_TRIPS = 3000
MAX_TARIFFS = 500


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )


class LatLng(ContractModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


TrafficFactor = Annotated[float, Field(ge=1, le=5)]


class TrafficBand(ContractModel):
    start_min: DayMinute
    end_min: DayMinute

    @model_validator(mode="after")
    def _ordered(self) -> TrafficBand:
        if self.end_min <= self.start_min:
            raise ValueError("traffic band endMin must be after startMin")
        return self


class TrafficZone(ContractModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    radius_km: float = Field(gt=0, le=100)
    factors: list[TrafficFactor]


class TrafficSettings(ContractModel):
    bands: list[TrafficBand] = Field(min_length=1)
    road_factors: list[TrafficFactor]
    zones: list[TrafficZone]

    @model_validator(mode="after")
    def _consistent(self) -> TrafficSettings:
        for earlier, later in zip(self.bands, self.bands[1:], strict=False):
            if later.start_min < earlier.end_min:
                raise ValueError("traffic bands must be sorted and must not overlap")
        count = len(self.bands)
        if len(self.road_factors) != count or any(len(zone.factors) != count for zone in self.zones):
            raise ValueError("one traffic factor per band is required")
        return self


class Settings(ContractModel):
    wait_before_appointment_min: int = Field(ge=0, le=180)
    wait_after_session_min: int = Field(ge=0, le=180)
    max_total_wait_min: int = Field(ge=0, le=360)
    max_detour_km_per_extra_patient: float = Field(ge=0)
    max_detour_km_total: float = Field(ge=0)
    pickup_service_min: int = Field(ge=0, le=60)
    dropoff_service_min: int = Field(ge=0, le=60)
    unassigned_penalty: float = Field(ge=0)
    time_limit_sec: int = Field(ge=1, le=600)
    max_ride_extra_min: int = Field(default=DEFAULT_MAX_RIDE_EXTRA_MIN, ge=0, le=180)
    """Time on board (end of the pickup to start of the dropoff) above the direct drive allowed to a patient."""
    traffic: TrafficSettings | None = None


class BreakRule(ContractModel):
    window_start_min: DayMinute
    window_end_min: DayMinute
    duration_min: int = Field(ge=0, le=MINUTES_PER_DAY)

    @model_validator(mode="after")
    def _window_fits(self) -> BreakRule:
        if self.window_end_min - self.window_start_min < self.duration_min:
            raise ValueError("break window shorter than break duration")
        return self


class Vehicle(ContractModel):
    id: str = Field(min_length=1)
    label: str
    type: VehicleType
    capacity: int = Field(ge=1, le=8)
    depot: LatLng
    department: str = Field(min_length=1)
    cost_per_km: float = Field(ge=0)
    cost_per_hour: float = Field(ge=0)
    shift_start_min: DayMinute
    shift_end_min: DayMinute
    break_: BreakRule | None = Field(default=None, alias="break")

    @model_validator(mode="after")
    def _shift_ordered(self) -> Vehicle:
        if self.shift_end_min <= self.shift_start_min:
            raise ValueError("shiftEndMin must be after shiftStartMin")
        return self


class Trip(ContractModel):
    id: str = Field(min_length=1)
    patient_id: str = Field(min_length=1)
    facility_id: str | None = None
    direction: Direction
    pickup: LatLng
    dropoff: LatLng
    appointment_min: DayMinute | None = None
    ready_min: DayMinute | None = None
    allowed_vehicle_types: list[VehicleType] = Field(min_length=1)
    shareable: bool
    locked_vehicle_id: str | None = None
    pickup_service_min: ServiceMinutes | None = None
    """Stop duration at this trip's pickup; None: settings.pickupServiceMin."""
    dropoff_service_min: ServiceMinutes | None = None
    """Stop duration at this trip's dropoff; None: settings.dropoffServiceMin."""

    @model_validator(mode="after")
    def _times_match_direction(self) -> Trip:
        if self.direction == "OUTBOUND" and self.appointment_min is None:
            raise ValueError("OUTBOUND trip requires appointmentMin")
        if self.direction == "RETURN" and self.ready_min is None:
            raise ValueError("RETURN trip requires readyMin")
        return self


class Tariff(ContractModel):
    vehicle_type: VehicleType
    department: str = Field(min_length=1)
    base_fare: float = Field(ge=0)
    price_per_km: float = Field(ge=0)
    included_km: float = Field(default=0, ge=0)
    shared_discount2: float = Field(ge=0, le=1)
    shared_discount3: float = Field(ge=0, le=1)


class StopRef(ContractModel):
    trip_id: str
    kind: StopKind


class RoutePlan(ContractModel):
    vehicle_id: str
    stops: list[StopRef] = Field(max_length=2 * MAX_TRIPS)


class DayRequest(ContractModel):
    """What both operations need: the day's settings, fleet, trips and tariffs."""

    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    settings: Settings
    vehicles: list[Vehicle] = Field(max_length=MAX_VEHICLES)
    trips: list[Trip] = Field(max_length=MAX_TRIPS)
    tariffs: list[Tariff] = Field(max_length=MAX_TARIFFS)


class OptimizeRequest(DayRequest):
    initial_routes: list[RoutePlan] | None = Field(default=None, max_length=MAX_VEHICLES)
    """The plan in place of the date, a start of the search: the plan returned is never worse than
    it once repaired to the rules of the request (contract/README.md, « Planning en place »)."""


class EvaluateRequest(DayRequest):
    routes: list[RoutePlan] = Field(max_length=MAX_VEHICLES)


class BreakSlot(ContractModel):
    start_min: int
    end_min: int


class Stop(ContractModel):
    trip_id: str
    kind: StopKind
    location: LatLng
    arrival_min: int
    start_min: int
    departure_min: int
    load_after: int = Field(ge=0)


class Route(ContractModel):
    vehicle_id: str
    start_min: int
    end_min: int
    distance_km: float
    empty_km: float
    loaded_km: float
    duration_min: int
    revenue: float
    cost: float
    margin: float
    break_: BreakSlot | None = Field(default=None, alias="break")
    stops: list[Stop]


class TripResult(ContractModel):
    trip_id: str
    vehicle_id: str | None
    pickup_min: int | None
    dropoff_min: int | None
    shared: bool
    co_passenger_trip_ids: list[str]
    direct_km: float
    ride_km: float
    detour_km: float
    revenue: float
    wait_at_facility_min: int | None


class Unassigned(ContractModel):
    trip_id: str
    reason: str


class Kpis(ContractModel):
    trips_total: int
    trips_served: int
    trips_unassigned: int
    vehicles_used: int
    trips_per_vehicle: float
    total_km: float
    empty_km: float
    empty_km_ratio: float
    shared_trips: int
    shared_trip_ratio: float
    revenue: float
    cost: float
    margin: float


class Violation(ContractModel):
    code: ViolationCode
    message: str
    trip_id: str | None = None
    vehicle_id: str | None = None


class Validation(ContractModel):
    valid: bool
    violations: list[Violation]


class Meta(ContractModel):
    matrix_source: MatrixSource
    traffic_source: TrafficSource
    solver_status: str
    objective: float | None
    wall_time_ms: int
    warnings: list[str]


class PlanResponse(ContractModel):
    status: PlanStatus
    routes: list[Route]
    trips: list[TripResult]
    unassigned: list[Unassigned]
    kpis: Kpis
    validation: Validation
    meta: Meta


class Health(ContractModel):
    status: Literal["ok"]
    matrix_source: MatrixSource
