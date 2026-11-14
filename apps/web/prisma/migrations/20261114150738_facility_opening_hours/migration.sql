-- Reception hours of a facility (PAT-04): opening and closing per weekday, earliest accepted arrival. Empty for
-- every existing facility: no bound, the requests to the optimizer stay the same.

-- AlterTable
ALTER TABLE "Facility" ADD COLUMN     "earliestArrivalMinute" INTEGER,
ADD COLUMN     "openingHours" JSONB NOT NULL DEFAULT '[]';
