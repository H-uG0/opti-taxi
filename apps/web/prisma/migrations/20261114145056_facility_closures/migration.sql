-- Public holidays and facility closures (PAT-03): a facility is open on public holidays or not (dialysis centres
-- are, the existing ones are set so below), and may be closed on dated periods. A closure cancels the trips to it
-- (origin SYSTEM, new reason FACILITY_CLOSED); a holiday only flags them.

-- AlterEnum
ALTER TYPE "CancellationReason" ADD VALUE 'FACILITY_CLOSED';

-- AlterTable
ALTER TABLE "Facility" ADD COLUMN     "openOnHolidays" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FacilityClosure" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityClosure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FacilityClosure_facilityId_startDate_idx" ON "FacilityClosure"("facilityId", "startDate");

-- AddForeignKey
ALTER TABLE "FacilityClosure" ADD CONSTRAINT "FacilityClosure_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Dialysis centres work on public holidays.
UPDATE "Facility" SET "openOnHolidays" = true WHERE "type" = 'DIALYSIS';
