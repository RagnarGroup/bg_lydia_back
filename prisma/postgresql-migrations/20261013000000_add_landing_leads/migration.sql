-- LYD-83: leads de la landing (visitas solicitadas) + historial de actividad por lead.
-- Generada con prisma migrate diff (sin base) y sin el prefijo de schema, como el resto de migraciones.

-- CreateEnum
CREATE TYPE "LeadVisitStatus" AS ENUM ('solicitada', 'confirmada', 'reprogramada', 'asistio', 'no_asistio', 'cancelada');

-- CreateEnum
CREATE TYPE "LeadActivityType" AS ENUM ('creado', 'tomado', 'liberado', 'estado_visita', 'reprogramada', 'nota', 'etapa');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "externalId" VARCHAR(120),
ADD COLUMN     "programa" VARCHAR(30),
ADD COLUMN     "sede" VARCHAR(50),
ADD COLUMN     "visitAt" TIMESTAMPTZ(3),
ADD COLUMN     "visitStatus" "LeadVisitStatus";

-- CreateTable
CREATE TABLE "LeadActivity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "agentId" TEXT,
    "type" "LeadActivityType" NOT NULL,
    "content" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadActivity_leadId_createdAt_idx" ON "LeadActivity"("leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_externalId_key" ON "Lead"("externalId");

-- CreateIndex
CREATE INDEX "Lead_source_idx" ON "Lead"("source");

-- CreateIndex
CREATE INDEX "Lead_sede_idx" ON "Lead"("sede");

-- CreateIndex
CREATE INDEX "Lead_visitAt_idx" ON "Lead"("visitAt");

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

