-- Course de reprise (DAY-03) : lien de la course qui reprend un patient à bord vers la course interrompue, et heure de
-- l'interruption. Les courses de reprise déjà créées sont retrouvées dans le journal d'audit (trip.create,
-- details.interrupts) ; l'heure reste vide pour elles. Aucune autre donnée n'est modifiée.

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "continuesTripId" TEXT,
ADD COLUMN     "interruptedAtMinute" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Trip_continuesTripId_key" ON "Trip"("continuesTripId");

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_continuesTripId_fkey" FOREIGN KEY ("continuesTripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: the continuations created before this column, one per interrupted trip (the earliest event wins).
UPDATE "Trip" AS t
SET "continuesTripId" = linked."interrupts"
FROM (
  SELECT DISTINCT ON (a."details"->>'interrupts') a."entityId" AS "tripId", a."details"->>'interrupts' AS "interrupts"
  FROM "AuditEvent" AS a
  JOIN "Trip" AS original ON original."id" = a."details"->>'interrupts'
  WHERE a."action" = 'trip.create' AND a."entity" = 'Trip' AND a."details" ? 'interrupts'
  ORDER BY a."details"->>'interrupts', a."at"
) AS linked
WHERE t."id" = linked."tripId";
