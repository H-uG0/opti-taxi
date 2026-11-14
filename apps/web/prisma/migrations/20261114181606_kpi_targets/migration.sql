-- Dashboard reference values and objectives (KPI-09): new table KpiTarget, empty (the values come from V, entered in
-- Paramètres). Index of the audit trail by service date: the planning time is read from it date by date (KPI-06).
-- New table and new index only; no existing row changes.

-- CreateTable
CREATE TABLE "KpiTarget" (
    "id" TEXT NOT NULL,
    "indicator" TEXT NOT NULL,
    "depotId" TEXT,
    "reference" DOUBLE PRECISION,
    "objective" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "KpiTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KpiTarget_indicator_depotId_key" ON "KpiTarget"("indicator", "depotId");

-- CreateIndex
CREATE INDEX "AuditEvent_serviceDate_at_idx" ON "AuditEvent"("serviceDate", "at");

-- AddForeignKey
ALTER TABLE "KpiTarget" ADD CONSTRAINT "KpiTarget_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KpiTarget" ADD CONSTRAINT "KpiTarget_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
