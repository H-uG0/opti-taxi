-- Staff planning (lot 3 of docs/besoin-et-solution.md): dated absences (leave, sickness, training,
-- on-call duty…), pairs of people not to put in the same crew, and the crew of a vehicle for a date
-- when the regulator fixed it. New tables only: no existing data changes.

-- CreateEnum
CREATE TYPE "AbsenceKind" AS ENUM ('LEAVE', 'SICK', 'TRAINING', 'ON_CALL', 'OTHER');

-- CreateTable
CREATE TABLE "StaffAbsence" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "kind" "AbsenceKind" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffAbsence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewIncompatibility" (
    "id" TEXT NOT NULL,
    "driverAId" TEXT NOT NULL,
    "driverBId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrewIncompatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DayCrew" (
    "id" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT,
    "crewMateId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DayCrew_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffAbsence_driverId_startDate_idx" ON "StaffAbsence"("driverId", "startDate");

-- CreateIndex
CREATE INDEX "StaffAbsence_startDate_endDate_idx" ON "StaffAbsence"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "CrewIncompatibility_driverAId_driverBId_key" ON "CrewIncompatibility"("driverAId", "driverBId");

-- CreateIndex
CREATE UNIQUE INDEX "DayCrew_serviceDate_vehicleId_key" ON "DayCrew"("serviceDate", "vehicleId");

-- AddForeignKey
ALTER TABLE "StaffAbsence" ADD CONSTRAINT "StaffAbsence_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewIncompatibility" ADD CONSTRAINT "CrewIncompatibility_driverAId_fkey" FOREIGN KEY ("driverAId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewIncompatibility" ADD CONSTRAINT "CrewIncompatibility_driverBId_fkey" FOREIGN KEY ("driverBId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayCrew" ADD CONSTRAINT "DayCrew_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayCrew" ADD CONSTRAINT "DayCrew_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayCrew" ADD CONSTRAINT "DayCrew_crewMateId_fkey" FOREIGN KEY ("crewMateId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
