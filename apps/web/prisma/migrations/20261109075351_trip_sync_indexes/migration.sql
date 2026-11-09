-- Indexes for the trip sync: a changed prescription or a moved facility reads its trips to come
-- (prescriptionId; facilityId + serviceDate), and facility pages read its recurrences (facilityId).
-- Indexes only: no data is changed.

-- CreateIndex
CREATE INDEX "Recurrence_facilityId_idx" ON "Recurrence"("facilityId");

-- CreateIndex
CREATE INDEX "Trip_prescriptionId_idx" ON "Trip"("prescriptionId");

-- CreateIndex
CREATE INDEX "Trip_facilityId_serviceDate_idx" ON "Trip"("facilityId", "serviceDate");
