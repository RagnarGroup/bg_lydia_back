-- LYD-115: tipo de lead. Los leads existentes quedan como `matricula`, que es
-- lo que eran implicitamente; las asesoras reclasifican a mano los que no.

-- CreateEnum
CREATE TYPE "LeadType" AS ENUM ('matricula', 'empleo', 'alumno_actual', 'otro');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "leadType" "LeadType" NOT NULL DEFAULT 'matricula';

-- CreateIndex
CREATE INDEX "Lead_leadType_idx" ON "Lead"("leadType");
