-- Dated patient absences (PAT-02): hospitalisation, holidays or another absence, from a first to a last day.
-- Their days generate no trip and the trips already created are cancelled by the application with the reason
-- HOSPITALIZATION or the new PATIENT_ABSENCE (origin SYSTEM: they come back once the absence is shortened or removed).

-- CreateEnum
CREATE TYPE "PatientAbsenceKind" AS ENUM ('HOSPITALIZATION', 'HOLIDAY', 'OTHER');

-- AlterEnum
ALTER TYPE "CancellationReason" ADD VALUE 'PATIENT_ABSENCE';

-- CreateTable
CREATE TABLE "PatientAbsence" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "kind" "PatientAbsenceKind" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientAbsence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientAbsence_patientId_startDate_idx" ON "PatientAbsence"("patientId", "startDate");

-- AddForeignKey
ALTER TABLE "PatientAbsence" ADD CONSTRAINT "PatientAbsence_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
