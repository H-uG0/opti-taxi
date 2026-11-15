-- Statuts saisis après coup (FLD-02) : heure réelle déclarée par l'équipage dans « Fin de tournée » ou corrigée par
-- la régulation avec un motif (RouteStop.completedSource, RouteStop.correctionReason). Deux colonnes nullables et deux
-- types nouveaux ; aucune donnée existante n'est modifiée (un statut existant reste « saisi sur le moment »).

-- CreateEnum
CREATE TYPE "StopEntrySource" AS ENUM ('DECLARED', 'CORRECTED');

-- CreateEnum
CREATE TYPE "StatusCorrectionReason" AS ENUM ('CREW_FORGOT', 'PHONE_ISSUE', 'WRONG_ENTRY', 'CREW_CALL', 'OTHER');

-- AlterTable
ALTER TABLE "RouteStop" ADD COLUMN     "completedSource" "StopEntrySource",
ADD COLUMN     "correctionReason" "StatusCorrectionReason";
