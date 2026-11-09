-- Driver statuses sent later from the phone's offline queue: completedAt is now the time of the
-- gesture, and the new completedReceivedAt keeps when the server received it. Statuses recorded
-- before this migration were stamped on receipt, so their reception time is their completedAt.

-- AlterTable
ALTER TABLE "RouteStop" ADD COLUMN     "completedReceivedAt" TIMESTAMP(3);

-- Existing statuses: received when they were stamped.
UPDATE "RouteStop" SET "completedReceivedAt" = "completedAt" WHERE "completedAt" IS NOT NULL;
