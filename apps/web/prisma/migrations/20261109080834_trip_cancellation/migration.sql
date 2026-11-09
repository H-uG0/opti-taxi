-- Cancellation of a trip: reason, origin (a person or the referential sync), note, instant, author and
-- whether it came late (setting lateCancellationHours, 2 h by default). Trips already cancelled keep
-- their status; their instant and author are taken from their last trip.cancel audit event.

-- CreateEnum
CREATE TYPE "CancellationReason" AS ENUM ('PATIENT', 'FACILITY', 'HOSPITALIZATION', 'OWN_MEANS', 'DECEASED', 'PARTNER', 'REFERENTIAL_SYNC', 'REGULATION', 'OTHER');

-- CreateEnum
CREATE TYPE "CancellationOrigin" AS ENUM ('USER', 'SYSTEM');

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "lateCancellationHours" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "cancellationNote" TEXT,
ADD COLUMN     "cancellationOrigin" "CancellationOrigin",
ADD COLUMN     "cancellationReason" "CancellationReason",
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "lateCancellation" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: when and by whom each trip already cancelled was cancelled (its last trip.cancel event).
-- The origin stays unknown (NULL): such a trip is never brought back automatically, as a person's.
UPDATE "Trip" AS t
SET "cancelledAt" = e."at", "cancelledById" = e."userId"
FROM (
  SELECT DISTINCT ON ("entityId") "entityId", "at", "userId"
  FROM "AuditEvent"
  WHERE "action" = 'trip.cancel' AND "entity" = 'Trip' AND "entityId" IS NOT NULL
  ORDER BY "entityId", "at" DESC
) AS e
WHERE t."id" = e."entityId" AND t."status" = 'CANCELLED';

-- Trips handed over to a partner company by the development history script (prisma/history) were
-- written as cancelled with a note: they get their reason.
UPDATE "Trip"
SET "cancellationReason" = 'PARTNER', "cancellationOrigin" = 'USER'
WHERE "status" = 'CANCELLED' AND "notes" LIKE '%confiée à un confrère%';
