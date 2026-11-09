-- Tariff model of the 2025 conventions (TAR-01) and exceptional ambulance for a seated trip (TAR-03).
-- Existing grids keep their revenue: the two sharing discounts become sharedDiscounts [{2}, {3}], capped at
-- 3 patients as before; no surcharge, supplement or certification (certified NULL applies to any company).


-- CreateEnum
CREATE TYPE "TariffVerification" AS ENUM ('OFFICIAL', 'SECONDARY', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "TariffAreaKind" AS ENUM ('BIG_CITY', 'AGGLOMERATION');

-- CreateEnum
CREATE TYPE "TariffAreaRule" AS ENUM ('ANY_END', 'BOTH_INSIDE', 'TO_HUB');

-- CreateEnum
CREATE TYPE "EmptyLegRule" AS ENUM ('NONE', 'DEPOT');

-- CreateEnum
CREATE TYPE "SurchargeOrder" AS ENUM ('MULTIPLICATIVE', 'ADDITIVE');

-- CreateEnum
CREATE TYPE "SharedPatientCount" AS ENUM ('DISTINCT', 'MAX_ON_BOARD');

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "emptyLegRule" "EmptyLegRule" NOT NULL DEFAULT 'DEPOT',
ADD COLUMN     "hqCity" TEXT,
ADD COLUMN     "hqDepartment" TEXT,
ADD COLUMN     "sharedPatientCount" "SharedPatientCount" NOT NULL DEFAULT 'DISTINCT',
ADD COLUMN     "surchargeOrder" "SurchargeOrder" NOT NULL DEFAULT 'MULTIPLICATIVE';

-- AlterTable
ALTER TABLE "TariffGrid" ADD COLUMN     "aggloFare" DOUBLE PRECISION,
ADD COLUMN     "aloneDiscount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "aloneThresholdKm" DOUBLE PRECISION NOT NULL DEFAULT 30,
ADD COLUMN     "bigCityFare" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "billableDetourKm" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "certified" BOOLEAN,
ADD COLUMN     "emptyLegRateLong" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "emptyLegRateShort" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "emptyLegThresholdKm" DOUBLE PRECISION NOT NULL DEFAULT 50,
ADD COLUMN     "maxSharedPatients" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "nightEndMinute" INTEGER NOT NULL DEFAULT 480,
ADD COLUMN     "nightRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "nightStartMinute" INTEGER NOT NULL DEFAULT 1200,
ADD COLUMN     "saturdayFromMinute" INTEGER NOT NULL DEFAULT 720,
ADD COLUMN     "sharedDiscounts" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "shortTripBands" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sourceUrl" TEXT,
ADD COLUMN     "surchargeShortTrip" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tpmrFare" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "verification" "TariffVerification" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "weekendRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "zone" TEXT;

-- Data: the old discounts at 2 and 3 patients (3 and more before: capped at 3), then the old columns go.
UPDATE "TariffGrid"
SET "sharedDiscounts" = jsonb_build_array(
      jsonb_build_object('patients', 2, 'rate', "sharedDiscount2"),
      jsonb_build_object('patients', 3, 'rate', "sharedDiscount3")
    ),
    "maxSharedPatients" = 3
WHERE "sharedDiscount2" > 0 OR "sharedDiscount3" > 0;
UPDATE "TariffGrid" SET "maxSharedPatients" = 3 WHERE "sharedDiscount2" = 0 AND "sharedDiscount3" = 0;

ALTER TABLE "TariffGrid" DROP COLUMN "sharedDiscount2",
DROP COLUMN "sharedDiscount3";

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "exceptionalAmbulanceAt" TIMESTAMP(3),
ADD COLUMN     "exceptionalAmbulanceById" TEXT,
ADD COLUMN     "tollAmount" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "tpmrEquipped" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CompanyCertification" (
    "id" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyCertification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffArea" (
    "id" TEXT NOT NULL,
    "kind" "TariffAreaKind" NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "communes" TEXT[],
    "rule" "TariffAreaRule" NOT NULL,
    "hubCommune" TEXT,
    "validFrom" DATE,
    "validTo" DATE,
    "verification" "TariffVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "sourceUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TariffArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicHoliday" (
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("date")
);

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_exceptionalAmbulanceById_fkey" FOREIGN KEY ("exceptionalAmbulanceById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

