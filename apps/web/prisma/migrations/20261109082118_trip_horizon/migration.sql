-- Horizon of the trips generated from the recurrences: from tomorrow to D+N (14 days by default),
-- completed whenever a recurrence, a prescription or a patient is created, changed or reactivated.
-- New setting with its default; no data is changed.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "tripHorizonDays" INTEGER NOT NULL DEFAULT 14;
