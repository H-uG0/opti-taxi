-- « Modifier la course » and recurrence notes (PAT-07): a recurrence's notes are copied to its trips; a trip
-- keeps the date of the recurrence session it serves when it moves to another day (occurrenceDate, the new key
-- of a recurring trip), and may take a one-off home-side address. Existing recurring trips serve their own day.

-- AlterTable
ALTER TABLE "Recurrence" ADD COLUMN "notes" TEXT;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "occurrenceDate" DATE,
ADD COLUMN "oneOffAddress" BOOLEAN NOT NULL DEFAULT false;

-- Every trip of a recurrence serves the session of its own day.
UPDATE "Trip" SET "occurrenceDate" = "serviceDate" WHERE "recurrenceId" IS NOT NULL;

-- The key of a recurring trip: its recurrence, the session served and the leg (was its service date).
DROP INDEX "Trip_recurrenceId_serviceDate_direction_key";

-- CreateIndex
CREATE UNIQUE INDEX "Trip_recurrenceId_occurrenceDate_direction_key" ON "Trip"("recurrenceId", "occurrenceDate", "direction");
