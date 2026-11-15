-- Compteur et pleins saisis depuis le téléphone (FLD-03) : relevés du compteur de début et de fin de journée
-- (table OdometerReading, un par véhicule, jour et moment) et auteur d'un plein (FuelLog.recordedById, nullable).
-- Aucune donnée existante n'est modifiée : les pleins déjà saisis restent sans auteur connu.

-- CreateEnum
CREATE TYPE "OdometerMoment" AS ENUM ('START', 'END');

-- AlterTable
ALTER TABLE "FuelLog" ADD COLUMN     "recordedById" TEXT;

-- CreateTable
CREATE TABLE "OdometerReading" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "moment" "OdometerMoment" NOT NULL,
    "km" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OdometerReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OdometerReading_vehicleId_km_idx" ON "OdometerReading"("vehicleId", "km");

-- CreateIndex
CREATE UNIQUE INDEX "OdometerReading_vehicleId_serviceDate_moment_key" ON "OdometerReading"("vehicleId", "serviceDate", "moment");

-- AddForeignKey
ALTER TABLE "FuelLog" ADD CONSTRAINT "FuelLog_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OdometerReading" ADD CONSTRAINT "OdometerReading_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
