-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "eveningPeakEndMinute" INTEGER NOT NULL DEFAULT 1140,
ADD COLUMN     "eveningPeakStartMinute" INTEGER NOT NULL DEFAULT 960,
ADD COLUMN     "morningPeakEndMinute" INTEGER NOT NULL DEFAULT 570,
ADD COLUMN     "morningPeakStartMinute" INTEGER NOT NULL DEFAULT 420,
ADD COLUMN     "trafficChangedAt" TIMESTAMP(3),
ADD COLUMN     "trafficEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "TrafficZone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "radiusKm" DOUBLE PRECISION,
    "morningFactor" DOUBLE PRECISION NOT NULL,
    "dayFactor" DOUBLE PRECISION NOT NULL,
    "eveningFactor" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrafficZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrafficZone_name_key" ON "TrafficZone"("name");
