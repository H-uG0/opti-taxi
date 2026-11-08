-- Vehicle planning (lot 4 of docs/besoin-et-solution.md): dated unavailability (maintenance, repair,
-- inspection, on-call duty…), maintenance deadlines by date and/or mileage, fuel and charging log, and
-- the energy of each vehicle (nullable: not filled in for existing vehicles). No existing data changes.

-- CreateEnum
CREATE TYPE "VehicleUnavailabilityKind" AS ENUM ('MAINTENANCE', 'REPAIR', 'INSPECTION', 'ON_CALL', 'OTHER');

-- CreateEnum
CREATE TYPE "MaintenanceKind" AS ENUM ('INSPECTION', 'SERVICE', 'TIRES', 'INSURANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "EnergyType" AS ENUM ('DIESEL', 'PETROL', 'HYBRID', 'ELECTRIC', 'OTHER');

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "energy" "EnergyType";

-- CreateTable
CREATE TABLE "VehicleUnavailability" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "kind" "VehicleUnavailabilityKind" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleUnavailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceDeadline" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "kind" "MaintenanceKind" NOT NULL,
    "label" TEXT,
    "dueDate" DATE,
    "dueKm" INTEGER,
    "note" TEXT,
    "doneDate" DATE,
    "doneKm" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceDeadline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelLog" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "odometerKm" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "fullTank" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleUnavailability_vehicleId_startDate_idx" ON "VehicleUnavailability"("vehicleId", "startDate");

-- CreateIndex
CREATE INDEX "VehicleUnavailability_startDate_endDate_idx" ON "VehicleUnavailability"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "MaintenanceDeadline_vehicleId_idx" ON "MaintenanceDeadline"("vehicleId");

-- CreateIndex
CREATE INDEX "FuelLog_vehicleId_date_idx" ON "FuelLog"("vehicleId", "date");

-- AddForeignKey
ALTER TABLE "VehicleUnavailability" ADD CONSTRAINT "VehicleUnavailability_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceDeadline" ADD CONSTRAINT "MaintenanceDeadline_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelLog" ADD CONSTRAINT "FuelLog_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
