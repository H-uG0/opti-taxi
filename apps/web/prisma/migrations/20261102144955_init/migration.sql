-- CreateEnum
CREATE TYPE "Mobility" AS ENUM ('SEATED', 'WHEELCHAIR', 'LYING');

-- CreateEnum
CREATE TYPE "PrescribedMode" AS ENUM ('TAP', 'AMBULANCE');

-- CreateEnum
CREATE TYPE "SharingScope" AS ENUM ('NONE', 'OUTBOUND', 'RETURN', 'BOTH');

-- CreateEnum
CREATE TYPE "FacilityType" AS ENUM ('HOSPITAL', 'DIALYSIS', 'RADIOTHERAPY', 'CHEMOTHERAPY', 'CLINIC', 'OTHER');

-- CreateEnum
CREATE TYPE "RecurrenceLegs" AS ENUM ('OUTBOUND', 'RETURN', 'BOTH');

-- CreateEnum
CREATE TYPE "TripDirection" AS ENUM ('OUTBOUND', 'RETURN');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('PLANNED', 'ASSIGNED', 'PICKED_UP', 'DROPPED_OFF', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "SharingStatus" AS ENUM ('NOT_ELIGIBLE', 'NOT_PROPOSED', 'PROPOSED', 'ACCEPTED', 'REFUSED');

-- CreateEnum
CREATE TYPE "Payer" AS ENUM ('CPAM', 'PRIVATE');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('TAXI', 'VSL', 'AMBULANCE');

-- CreateEnum
CREATE TYPE "Qualification" AS ENUM ('TAXI_CARD', 'AUXILIARY', 'DEA');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('PROPOSED', 'VALIDATED');

-- CreateEnum
CREATE TYPE "StopKind" AS ENUM ('PICKUP', 'DROPOFF');

-- CreateEnum
CREATE TYPE "OptimizationRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('REGULATOR', 'DRIVER');

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "mobility" "Mobility" NOT NULL DEFAULT 'SEATED',
    "accessNotes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Facility" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FacilityType" NOT NULL,
    "address" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prescription" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "mode" "PrescribedMode" NOT NULL,
    "sharing" "SharingScope" NOT NULL DEFAULT 'BOTH',
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "isSeries" BOOLEAN NOT NULL DEFAULT false,
    "prescriber" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recurrence" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "label" TEXT,
    "weekdays" INTEGER[],
    "appointmentMinute" INTEGER NOT NULL,
    "sessionMinutes" INTEGER NOT NULL,
    "legs" "RecurrenceLegs" NOT NULL DEFAULT 'BOTH',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "direction" "TripDirection" NOT NULL,
    "patientId" TEXT NOT NULL,
    "prescriptionId" TEXT,
    "recurrenceId" TEXT,
    "facilityId" TEXT,
    "payer" "Payer" NOT NULL DEFAULT 'CPAM',
    "allowedVehicleTypes" "VehicleType"[],
    "pickupAddress" TEXT NOT NULL,
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "dropoffAddress" TEXT NOT NULL,
    "dropoffLat" DOUBLE PRECISION NOT NULL,
    "dropoffLng" DOUBLE PRECISION NOT NULL,
    "appointmentMinute" INTEGER,
    "readyMinute" INTEGER,
    "status" "TripStatus" NOT NULL DEFAULT 'PLANNED',
    "sharingAllowed" BOOLEAN NOT NULL DEFAULT false,
    "sharingStatus" "SharingStatus" NOT NULL DEFAULT 'NOT_PROPOSED',
    "sharingProposedAt" TIMESTAMP(3),
    "sharingRespondedAt" TIMESTAMP(3),
    "sharingNote" TEXT,
    "lockedVehicleId" TEXT,
    "routeId" TEXT,
    "plannedPickupMinute" INTEGER,
    "plannedDropoffMinute" INTEGER,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "directKm" DOUBLE PRECISION,
    "detourKm" DOUBLE PRECISION,
    "estimatedRevenue" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "type" "VehicleType" NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 2,
    "depotLabel" TEXT NOT NULL,
    "depotAddress" TEXT NOT NULL,
    "depotLat" DOUBLE PRECISION NOT NULL,
    "depotLng" DOUBLE PRECISION NOT NULL,
    "department" TEXT NOT NULL,
    "costPerKm" DOUBLE PRECISION NOT NULL,
    "defaultDriverId" TEXT,
    "defaultCrewMateId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "qualifications" "Qualification"[],
    "workDays" INTEGER[],
    "shiftStartMinute" INTEGER NOT NULL,
    "shiftEndMinute" INTEGER NOT NULL,
    "breakWindowStartMinute" INTEGER,
    "breakWindowEndMinute" INTEGER,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "hourlyCost" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "crewMateId" TEXT,
    "status" "RouteStatus" NOT NULL DEFAULT 'PROPOSED',
    "optimizationRunId" TEXT,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "emptyKm" DOUBLE PRECISION NOT NULL,
    "revenue" DOUBLE PRECISION NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "margin" DOUBLE PRECISION NOT NULL,
    "breakStartMinute" INTEGER,
    "breakEndMinute" INTEGER,
    "validatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteStop" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "tripId" TEXT NOT NULL,
    "kind" "StopKind" NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "address" TEXT NOT NULL,
    "arrivalMinute" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "departureMinute" INTEGER NOT NULL,
    "loadAfter" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RouteStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffGrid" (
    "id" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "department" TEXT NOT NULL,
    "label" TEXT,
    "baseFare" DOUBLE PRECISION NOT NULL,
    "pricePerKm" DOUBLE PRECISION NOT NULL,
    "includedKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sharedDiscount2" DOUBLE PRECISION NOT NULL,
    "sharedDiscount3" DOUBLE PRECISION NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TariffGrid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "waitBeforeAppointmentMin" INTEGER NOT NULL DEFAULT 30,
    "waitAfterSessionMin" INTEGER NOT NULL DEFAULT 15,
    "maxTotalWaitMin" INTEGER NOT NULL DEFAULT 45,
    "maxDetourKmPerExtraPatient" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "maxDetourKmTotal" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "pickupServiceMin" INTEGER NOT NULL DEFAULT 5,
    "dropoffServiceMin" INTEGER NOT NULL DEFAULT 5,
    "unassignedPenalty" DOUBLE PRECISION NOT NULL DEFAULT 10000,
    "solverTimeLimitSec" INTEGER NOT NULL DEFAULT 10,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptimizationRun" (
    "id" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "status" "OptimizationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "tripsCount" INTEGER NOT NULL DEFAULT 0,
    "lockedCount" INTEGER NOT NULL DEFAULT 0,
    "unassignedCount" INTEGER NOT NULL DEFAULT 0,
    "objective" DOUBLE PRECISION,
    "wallTimeMs" INTEGER,
    "matrixSource" TEXT,
    "valid" BOOLEAN,
    "kpis" JSONB,
    "error" TEXT,

    CONSTRAINT "OptimizationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "driverId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Patient_lastName_firstName_idx" ON "Patient"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "Prescription_patientId_idx" ON "Prescription"("patientId");

-- CreateIndex
CREATE INDEX "Recurrence_patientId_idx" ON "Recurrence"("patientId");

-- CreateIndex
CREATE INDEX "Trip_serviceDate_idx" ON "Trip"("serviceDate");

-- CreateIndex
CREATE INDEX "Trip_patientId_serviceDate_idx" ON "Trip"("patientId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_recurrenceId_serviceDate_direction_key" ON "Trip"("recurrenceId", "serviceDate", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_registration_key" ON "Vehicle"("registration");

-- CreateIndex
CREATE UNIQUE INDEX "Route_serviceDate_vehicleId_key" ON "Route"("serviceDate", "vehicleId");

-- CreateIndex
CREATE INDEX "RouteStop_tripId_idx" ON "RouteStop"("tripId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteStop_routeId_sequence_key" ON "RouteStop"("routeId", "sequence");

-- CreateIndex
CREATE INDEX "TariffGrid_vehicleType_department_idx" ON "TariffGrid"("vehicleType", "department");

-- CreateIndex
CREATE INDEX "OptimizationRun_serviceDate_idx" ON "OptimizationRun"("serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_driverId_key" ON "User"("driverId");

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recurrence" ADD CONSTRAINT "Recurrence_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recurrence" ADD CONSTRAINT "Recurrence_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recurrence" ADD CONSTRAINT "Recurrence_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_recurrenceId_fkey" FOREIGN KEY ("recurrenceId") REFERENCES "Recurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_lockedVehicleId_fkey" FOREIGN KEY ("lockedVehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_defaultDriverId_fkey" FOREIGN KEY ("defaultDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_defaultCrewMateId_fkey" FOREIGN KEY ("defaultCrewMateId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_crewMateId_fkey" FOREIGN KEY ("crewMateId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_optimizationRunId_fkey" FOREIGN KEY ("optimizationRunId") REFERENCES "OptimizationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStop" ADD CONSTRAINT "RouteStop_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptimizationRun" ADD CONSTRAINT "OptimizationRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
