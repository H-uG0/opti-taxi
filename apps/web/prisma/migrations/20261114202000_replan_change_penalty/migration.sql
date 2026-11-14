-- Pénalité de changement d'une réoptimisation (DAY-02) : euros par course que le nouveau planning fait changer de
-- véhicule par rapport au planning en place (tournées déjà connues des chauffeurs). Colonne ajoutée avec sa valeur
-- par défaut (15 €) : aucune donnée existante n'est modifiée.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "replanChangePenalty" DOUBLE PRECISION NOT NULL DEFAULT 15;
