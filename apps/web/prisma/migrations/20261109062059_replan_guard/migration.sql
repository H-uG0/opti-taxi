-- Replanning guard: a new computation that serves fewer trips, breaks more rules or loses margin
-- beyond these thresholds waits for the regulator's confirmation (AWAITING_CONFIRMATION) instead
-- of replacing the routes in place. Existing settings rows get the defaults; no data is changed.

-- AlterEnum
ALTER TYPE "OptimizationRunStatus" ADD VALUE 'AWAITING_CONFIRMATION';

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "replanMaxMarginLoss" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
ADD COLUMN     "replanMaxServedLoss" INTEGER NOT NULL DEFAULT 0;
