-- Crew rules (Paramètres « Équipages »): replacement distance between depots, shared working time
-- of an ambulance pair, reserve kept per depot; and the author of each fixed crew of a day (DayCrew),
-- so a concurrent change can say who made it. Defaults only; no data is lost.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "crewMaxReplacementKm" DOUBLE PRECISION NOT NULL DEFAULT 60,
ADD COLUMN     "crewMinPairOverlapMin" INTEGER NOT NULL DEFAULT 240,
ADD COLUMN     "crewReservePerDepot" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DayCrew" ADD COLUMN     "updatedById" TEXT;

-- AddForeignKey
ALTER TABLE "DayCrew" ADD CONSTRAINT "DayCrew_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing fixed crews: until now a save rewrote every crew of its date, so the author of a row is
-- the author of the latest « day_crew.save » event of that date (read only from the audit trail).
UPDATE "DayCrew" d
SET "updatedById" = (
  SELECT e."userId" FROM "AuditEvent" e
  WHERE e."action" = 'day_crew.save' AND e."serviceDate" = d."serviceDate" AND e."userId" IS NOT NULL
  ORDER BY e."at" DESC
  LIMIT 1
)
WHERE d."updatedById" IS NULL;
