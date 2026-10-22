-- LYD-102: auditoria comercial diaria META K-01 (corridas y evaluaciones por conversacion).

-- CreateEnum
CREATE TYPE "CommercialAuditStatus" AS ENUM ('running', 'evaluated', 'sent', 'failed');

-- CreateTable
CREATE TABLE "CommercialAuditRun" (
    "id" TEXT NOT NULL,
    "reportDate" VARCHAR(10) NOT NULL,
    "windowStart" INTEGER NOT NULL,
    "windowEnd" INTEGER NOT NULL,
    "status" "CommercialAuditStatus" NOT NULL DEFAULT 'running',
    "conversations" INTEGER NOT NULL DEFAULT 0,
    "unattributed" INTEGER NOT NULL DEFAULT 0,
    "html" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "CommercialAuditRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationAudit" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "agentId" TEXT,
    "attribution" VARCHAR(20) NOT NULL,
    "applicable" BOOLEAN NOT NULL,
    "total" INTEGER,
    "lossAversion" INTEGER,
    "cta" INTEGER,
    "diagnostico" INTEGER,
    "valor" INTEGER,
    "ejecucion" INTEGER,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommercialAuditRun_reportDate_key" ON "CommercialAuditRun"("reportDate");

-- CreateIndex
CREATE INDEX "ConversationAudit_runId_idx" ON "ConversationAudit"("runId");

-- CreateIndex
CREATE INDEX "ConversationAudit_agentId_createdAt_idx" ON "ConversationAudit"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConversationAudit" ADD CONSTRAINT "ConversationAudit_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CommercialAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationAudit" ADD CONSTRAINT "ConversationAudit_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

