-- Suivi du jour J (DAY-04, DAY-05) : versions publiées des feuilles de route (empreinte, heure du changement, « J'ai vu »)
-- et demandes du terrain (fin de séance, demande d'annulation ou de retour, prochaine séance). Deux tables et deux
-- types nouveaux ; aucune donnée existante n'est modifiée.

-- CreateEnum
CREATE TYPE "FieldRequestKind" AS ENUM ('READY_TIME', 'CANCEL', 'RETURN', 'NEXT_SESSION');

-- CreateEnum
CREATE TYPE "FieldRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REFUSED', 'NOTED');

-- CreateTable
CREATE TABLE "RouteVersion" (
    "id" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "stops" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3),
    "seenById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldRequest" (
    "id" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "kind" "FieldRequestKind" NOT NULL,
    "status" "FieldRequestStatus" NOT NULL DEFAULT 'PENDING',
    "tripId" TEXT NOT NULL,
    "readyMinute" INTEGER,
    "previousReadyMinute" INTEGER,
    "cancellationReason" "CancellationReason",
    "nextSessionDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdTripId" TEXT,

    CONSTRAINT "FieldRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RouteVersion_serviceDate_vehicleId_version_key" ON "RouteVersion"("serviceDate", "vehicleId", "version");

-- CreateIndex
CREATE INDEX "FieldRequest_serviceDate_status_idx" ON "FieldRequest"("serviceDate", "status");

-- CreateIndex
CREATE INDEX "FieldRequest_tripId_idx" ON "FieldRequest"("tripId");

-- AddForeignKey
ALTER TABLE "RouteVersion" ADD CONSTRAINT "RouteVersion_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteVersion" ADD CONSTRAINT "RouteVersion_seenById_fkey" FOREIGN KEY ("seenById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldRequest" ADD CONSTRAINT "FieldRequest_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldRequest" ADD CONSTRAINT "FieldRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldRequest" ADD CONSTRAINT "FieldRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
