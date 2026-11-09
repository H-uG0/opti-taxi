-- Optimizer rules of 9 November 2026: stop durations by transport mode, mobility and facility, and
-- the longest time on board (settings); the distance source of each route's stored times, filled for
-- the existing routes from the run that computed them (traffic calibration on one source only).

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "ambulanceDropoffServiceMin" INTEGER,
ADD COLUMN     "ambulancePickupServiceMin" INTEGER,
ADD COLUMN     "lyingExtraServiceMin" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "maxRideExtraMin" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "wheelchairExtraServiceMin" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Facility" ADD COLUMN     "extraServiceMin" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Route" ADD COLUMN     "matrixSource" TEXT;

-- Existing routes: the source of the run that computed them (null when the run is gone).
UPDATE "Route" AS r
SET "matrixSource" = o."matrixSource"
FROM "OptimizationRun" AS o
WHERE r."optimizationRunId" = o."id";
