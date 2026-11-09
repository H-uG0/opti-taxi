-- Provisional driver passwords: a password set by a regulator (account creation or reset) must be
-- replaced by the driver before the roadmap opens. Existing accounts keep their password as is
-- (false): only the next creation or reset makes one provisional.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
