-- Depots become their own table (lot 2 of docs/besoin-et-solution.md). Nothing is lost: one Depot
-- per distinct place of the existing vehicles (label, address, coordinates), each vehicle linked
-- to its place, and each driver attached to the depot of a vehicle they crew by default.

-- CreateTable
CREATE TABLE "Depot" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Depot_pkey" PRIMARY KEY ("id")
);

-- One depot per distinct place of the vehicles; the id is derived from the place.
INSERT INTO "Depot" ("id", "name", "address", "lat", "lng", "updatedAt")
SELECT 'depot_' || md5(concat_ws('|', "depotLabel", "depotAddress", "depotLat"::text, "depotLng"::text)),
       "depotLabel", "depotAddress", "depotLat", "depotLng", CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "depotLabel", "depotAddress", "depotLat", "depotLng" FROM "Vehicle") AS places;

-- AlterTable: each vehicle points at the depot of its old place, then the old columns go.
ALTER TABLE "Vehicle" ADD COLUMN "depotId" TEXT;
UPDATE "Vehicle"
SET "depotId" = 'depot_' || md5(concat_ws('|', "depotLabel", "depotAddress", "depotLat"::text, "depotLng"::text));
ALTER TABLE "Vehicle" ALTER COLUMN "depotId" SET NOT NULL;
ALTER TABLE "Vehicle" DROP COLUMN "depotAddress",
DROP COLUMN "depotLabel",
DROP COLUMN "depotLat",
DROP COLUMN "depotLng";

-- AlterTable: a driver is attached to the depot of a vehicle they crew by default (active
-- vehicles first, then as its driver rather than crew mate); none otherwise.
ALTER TABLE "Driver" ADD COLUMN "depotId" TEXT;
UPDATE "Driver" AS d
SET "depotId" = (
    SELECT v."depotId"
    FROM "Vehicle" AS v
    WHERE v."defaultDriverId" = d."id" OR v."defaultCrewMateId" = d."id"
    ORDER BY v."active" DESC, (v."defaultDriverId" = d."id") DESC, v."label", v."id"
    LIMIT 1
);

-- CreateIndex
CREATE INDEX "Vehicle_depotId_idx" ON "Vehicle"("depotId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
