-- LYD-133: auditoria comercial K01-V2.0. Las corridas pasan a ser unicas por
-- (fecha, version de rubrica); las existentes quedan como K01-V1.

-- AlterTable
ALTER TABLE "CommercialAuditRun" ADD COLUMN "rubricVersion" VARCHAR(20) NOT NULL DEFAULT 'K01-V1';

-- DropIndex
DROP INDEX "CommercialAuditRun_reportDate_key";

-- CreateIndex
CREATE UNIQUE INDEX "CommercialAuditRun_reportDate_rubricVersion_key" ON "CommercialAuditRun"("reportDate", "rubricVersion");

-- AlterTable
ALTER TABLE "ConversationAudit" ADD COLUMN "coverage" INTEGER,
ADD COLUMN "confidence" VARCHAR(10),
ADD COLUMN "state" VARCHAR(20);
