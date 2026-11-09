-- Audit trail made append-only: a trigger refuses any UPDATE, DELETE or TRUNCATE of "AuditEvent"
-- (only the development seed and history scripts lift it, inside their own transaction). Each event
-- now keeps its author's name (backfilled here, then filled by the app or by a trigger), the client
-- address, a user-agent hash and non-medical details; role becomes optional for failed sign-ins, and
-- an account that has events can no longer be deleted (it was SET NULL: the author was lost).

-- DropForeignKey
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_userId_fkey";

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "actorLabel" TEXT,
ADD COLUMN     "details" JSONB,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "userAgentHash" TEXT,
ALTER COLUMN "role" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing events: their author's current name (before the trigger below forbids updates).
UPDATE "AuditEvent" AS e SET "actorLabel" = u."name" FROM "User" AS u WHERE e."userId" = u."id";

-- An event written without a label (seed, history simulation, a manual insert) gets the account's name.
CREATE FUNCTION "audit_event_fill_actor_label"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."actorLabel" IS NULL AND NEW."userId" IS NOT NULL THEN
    SELECT "name" INTO NEW."actorLabel" FROM "User" WHERE "id" = NEW."userId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AuditEvent_actor_label" BEFORE INSERT ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "audit_event_fill_actor_label"();

-- Append-only. Lifting it takes the table owner (ALTER TABLE ... DISABLE TRIGGER), which the
-- production runtime role is not (README, « Journal d'audit »).
CREATE FUNCTION "audit_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only: % refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "AuditEvent_append_only" BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "audit_event_append_only"();

CREATE TRIGGER "AuditEvent_no_truncate" BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_event_append_only"();
