-- Frozen validated plan of a date (KPI-07): the dashboard indicators of its routes at validation, the « Prévu »
-- compared with what was served and done. New table only; no existing row changes. Days validated before this
-- migration have no frozen plan: the dashboard falls back to their current routes and says so.

-- CreateTable
CREATE TABLE "ValidatedPlan" (
    "serviceDate" DATE NOT NULL,
    "validatedAt" TIMESTAMP(3) NOT NULL,
    "validatedById" TEXT,
    "figures" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ValidatedPlan_pkey" PRIMARY KEY ("serviceDate")
);

-- AddForeignKey
ALTER TABLE "ValidatedPlan" ADD CONSTRAINT "ValidatedPlan_validatedById_fkey" FOREIGN KEY ("validatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
