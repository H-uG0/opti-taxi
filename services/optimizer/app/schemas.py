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
    "REVENUE",
]
EmptyLegRule = Literal["NONE", "DEPOT"]
SurchargeOrder = Literal["MULTIPLICATIVE", "ADDITIVE"]
PatientCountRule = Literal["DISTINCT", "MAX_ON_BOARD"]

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


IsoDate = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]


class PricingSettings(ContractModel):
    """Readings of the conventions the PO has not settled yet (contract/README.md, « Calcul du CA »)."""

    empty_leg: EmptyLegRule = "NONE"
    """Taxi empty-leg surcharge of a hospital-linked trip: NONE, or DEPOT (the outbound trip whose
    dropoff ends the route, the return trip whose pickup starts it: the vehicle drives empty to or
    from its station)."""
    empty_leg_order: SurchargeOrder = "MULTIPLICATIVE"
    """Empty-leg and night/weekend surcharges on the km fare: multiplied, or added."""
    patient_count: PatientCountRule = "DISTINCT"
    """Patients of a shared ride for its discount: 1 + distinct co-passengers, or most on board at once."""
    public_holidays: list[IsoDate] = Field(default_factory=list, max_length=400)
    """Public holidays (weekend surcharge); at least the planned date and the next day are needed."""


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
    pricing: PricingSettings = Field(default_factory=PricingSettings)
    """Absent or null: the defaults (no empty-leg surcharge, multiplied, distinct co-passengers, no holiday)."""

    @model_validator(mode="before")
    @classmethod
    def _null_pricing(cls, data: object) -> object:
        if isinstance(data, dict) and data.get("pricing", 0) is None:
            data = {key: value for key, value in data.items() if key != "pricing"}
        return data


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
    tariff_id: str | None = None
    """Grid of the vehicle's trips, chosen by the web (taxi: department of its ADS; VSL and
    ambulance: the company's certification and head office); None: revenue estimated at 0."""
    tpmr_equipped: bool = False
    """Fitted to carry a patient in their wheelchair (TPMR supplement of the grid)."""

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
    tariff_id: str | None = None
    """Grid of this trip whatever the vehicle (a seated trip exceptionally driven by an ambulance:
    the VSL grid); None: the vehicle's."""
    big_city: bool = False
    """Picked up or dropped in a « Grande ville » area: the grid's bigCityFare is added."""
    agglomeration: bool = False
    """Entirely inside the agglomeration of the company's head office: the grid's aggloFare replaces baseFare."""
    hospital_linked: bool = False
    """To or from a hospitalisation or a dialysis, chemotherapy or radiotherapy session (taxi empty leg)."""
    wheelchair: bool = False
    """The patient rides in their own wheelchair (TPMR supplement in a fitted vehicle)."""
    toll_amount: float = Field(default=0, ge=0, le=1000)
    """Tolls billed on this patient's invoice (euros), outside surcharges and discounts."""

    @model_validator(mode="after")
    def _times_match_direction(self) -> Trip:
        if self.direction == "OUTBOUND" and self.appointment_min is None:
            raise ValueError("OUTBOUND trip requires appointmentMin")
        if self.direction == "RETURN" and self.ready_min is None:
            raise ValueError("RETURN trip requires readyMin")
        return self


class ShortTripBand(ContractModel):
    up_to_km: float = Field(ge=0, le=1000)
    amount: float = Field(ge=0, le=1000)


class SharedDiscount(ContractModel):
    patients: int = Field(ge=2, le=8)
    rate: float = Field(ge=0, le=1)


Rate = Annotated[float, Field(ge=0, le=5)]
Km = Annotated[float, Field(ge=0, le=1000)]


class Tariff(ContractModel):
    """One grid, as the web picked it for the vehicles and trips that reference its id."""

    id: str = Field(min_length=1)
    vehicle_type: VehicleType
    base_fare: float = Field(ge=0, le=1000)
    agglo_fare: float | None = Field(default=None, ge=0, le=1000)
    """Replaces baseFare for a trip inside the head office's agglomeration (ambulance)."""
    big_city_fare: float = Field(default=0, ge=0, le=1000)
    included_km: Km = 0
    price_per_km: float = Field(ge=0, le=50)
    short_trip_bands: list[ShortTripBand] = Field(default_factory=list, max_length=50)
    """Added to the fare: the first band whose upToKm is at least the billed km."""
    night_rate: Rate = 0
    weekend_rate: Rate = 0
    night_start_min: int = Field(default=1200, ge=0, le=MINUTES_PER_DAY)
    night_end_min: int = Field(default=480, ge=0, le=MINUTES_PER_DAY)
    saturday_from_min: int = Field(default=720, ge=0, le=MINUTES_PER_DAY)
    surcharge_short_trip: bool = True
    empty_leg_rate_short: Rate = 0
    empty_leg_rate_long: Rate = 0
    empty_leg_threshold_km: Km = 50
    shared_discounts: list[SharedDiscount] = Field(default_factory=list, max_length=7)
    """Discount by number of patients; the largest entry also covers more patients."""
    max_shared_patients: int = Field(default=8, ge=1, le=8)
    alone_discount: float = Field(default=0, ge=0, le=1)
    alone_threshold_km: Km = 30
    billable_detour_km: list[Km] = Field(default_factory=list, max_length=7)
    """Detour billed to a shared patient: at most the sum of the first k entries (k co-passengers)."""
    tpmr_fare: float = Field(default=0, ge=0, le=1000)

    @model_validator(mode="after")
    def _ordered(self) -> Tariff:
        bands = [band.up_to_km for band in self.short_trip_bands]
        if any(later <= earlier for earlier, later in zip(bands, bands[1:], strict=False)):
            raise ValueError("shortTripBands must be sorted by increasing upToKm")
        counts = [discount.patients for discount in self.shared_discounts]
        if len(set(counts)) != len(counts):
            raise ValueError("one sharedDiscounts entry per number of patients")
        return self


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

    @model_validator(mode="after")
    def _tariff_references(self) -> DayRequest:
        ids = [tariff.id for tariff in self.tariffs]
        if len(set(ids)) != len(ids):
            raise ValueError("tariff ids must be unique")
        known = set(ids)
        unknown = {
            ref
            for ref in [*(vehicle.tariff_id for vehicle in self.vehicles), *(trip.tariff_id for trip in self.trips)]
            if ref is not None and ref not in known
        }
        if unknown:
            raise ValueError(f"unknown tariff id(s): {', '.join(sorted(unknown))}")
        return self


class OptimizeRequest(DayRequest):
    initial_routes: list[RoutePlan] | None = Field(default=None, max_length=MAX_VEHICLES)
    """The plan in place of the date, a start of the search: the plan returned is never worse than
    it once repaired to the rules of the request (contract/README.md, « Planning en place »)."""


class EvaluateRequest(DayRequest):
    routes: list[RoutePlan] = Field(max_length=MAX_VEHICLES)


class InsertRequest(DayRequest):
    """Where one trip fits in the routes in place (contract/README.md, « POST /insert »)."""

    routes: list[RoutePlan] = Field(max_length=MAX_VEHICLES)
    """The routes in place, kept as they are: the trip only goes into one of them."""
    trip_id: str = Field(min_length=1)
    """The trip to place: on one of `routes` (a move), or on none (a trip without a vehicle)."""
    vehicle_ids: list[str] | None = Field(default=None, max_length=MAX_VEHICLES)
    """Vehicles to try (a drop on one vehicle, « Appliquer »); None: every vehicle of the request."""

    @model_validator(mode="after")
    def _known_trip(self) -> InsertRequest:
        if all(trip.id != self.trip_id for trip in self.trips):
            raise ValueError("tripId must name a trip of the request")
        return self


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


RejectionKind = Literal["SHIFT", "BREAK", "OCCUPIED", "NO_ROOM", "RULES"]
"""Why a vehicle cannot take the trip (InsertRejection): its hours, its driver's break, the patients it
carries then, no room between its stops, or its route (as it is, or with the trip) failing a rule."""


class TimeShift(ContractModel):
    """A trip of the changed routes whose times move with the insertion."""

    trip_id: str
    pickup_min: int
    dropoff_min: int
    pickup_shift_min: int
    """New minus former start of the pickup (minutes, + later)."""
    dropoff_shift_min: int


class InsertOption(ContractModel):
    """The best place of the trip in one vehicle's route, with what it changes."""

    vehicle_id: str
    pickup_min: int
    dropoff_min: int
    shared: bool
    co_passenger_trip_ids: list[str]
    delta_km: float
    delta_empty_km: float
    delta_duration_min: int
    delta_revenue: float
    delta_cost: float
    delta_margin: float
    shifts: list[TimeShift]
    routes: list[Route]
    """The vehicle's route with the trip and, for a move, the former route without it (absent when
    left without stops), timed and priced as /evaluate reports them."""
    trips: list[TripResult]
    """Results of every trip of `routes`, the placed one included."""
    violations: list[Violation]
    """Rules `routes` still break: never one the insertion adds (such a place is rejected)."""


class InsertRejection(ContractModel):
    vehicle_id: str
    kind: RejectionKind
    reason: str
    """French, to follow the vehicle's name: « est en pause de 12:00 à 12:45 »."""


class InsertResponse(ContractModel):
    trip_id: str
    from_vehicle_id: str | None
    """Vehicle of the route the trip is on, None for a trip without a vehicle."""
    options: list[InsertOption]
    """Best margin first."""
    rejected: list[InsertRejection]
    """Vehicles of an allowed type that cannot take the trip (its current vehicle aside), request order."""
    meta: Meta


class Health(ContractModel):
    status: Literal["ok"]
    matrix_source: MatrixSource
