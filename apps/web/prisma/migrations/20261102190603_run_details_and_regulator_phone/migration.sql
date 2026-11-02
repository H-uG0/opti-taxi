-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "regulatorPhone" TEXT;

-- AlterTable
ALTER TABLE "OptimizationRun" ADD COLUMN     "details" JSONB;
