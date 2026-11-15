-- Statuts du terrain (FLD-01) : « Arrivé » sur une prise en charge (RouteStop.arrivedAt), motif d'une absence
-- (Trip.noShowReason, un code), retard annoncé et patient pas prêt (FieldRequest LATE / NOT_READY, avec lateMinutes et
-- stopKind), attente minimale avant une absence (AppSettings.noShowMinWaitMin, 0). Colonnes nouvelles et nullables ou
-- avec une valeur par défaut : aucune donnée existante n'est modifiée.

-- CreateEnum
CREATE TYPE "NoShowReason" AS ENUM ('NO_ANSWER', 'REFUSED', 'HOSPITALIZED', 'FACILITY_CANCELLED', 'OTHER');

-- AlterEnum (PostgreSQL 12 and later: several values in one migration)
ALTER TYPE "FieldRequestKind" ADD VALUE 'LATE';
ALTER TYPE "FieldRequestKind" ADD VALUE 'NOT_READY';

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "noShowMinWaitMin" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "FieldRequest" ADD COLUMN     "lateMinutes" INTEGER,
ADD COLUMN     "stopKind" "StopKind";

-- AlterTable
ALTER TABLE "RouteStop" ADD COLUMN     "arrivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "noShowReason" "NoShowReason";
