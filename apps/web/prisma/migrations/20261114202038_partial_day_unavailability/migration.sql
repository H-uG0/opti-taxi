-- Indisponibilité à partir d'une heure (DAY-03) : un véhicule hors service ou une personne indisponible en cours de
-- journée. Heures facultatives (null : toute la journée, comme avant) sur VehicleUnavailability et StaffAbsence, et
-- motif d'annulation INTERRUPTED pour un transport interrompu en route. Aucune donnée existante n'est modifiée.

-- AlterEnum
ALTER TYPE "CancellationReason" ADD VALUE 'INTERRUPTED';

-- AlterTable
ALTER TABLE "StaffAbsence" ADD COLUMN     "endMinute" INTEGER,
ADD COLUMN     "startMinute" INTEGER;

-- AlterTable
ALTER TABLE "VehicleUnavailability" ADD COLUMN     "endMinute" INTEGER,
ADD COLUMN     "startMinute" INTEGER;
