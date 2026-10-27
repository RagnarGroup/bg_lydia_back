-- LYD-117: porcentaje de participacion de cada asesora por conversacion.

-- CreateTable
CREATE TABLE "ConversationParticipation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationParticipation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipation_runId_chatId_agentId_key" ON "ConversationParticipation"("runId", "chatId", "agentId");

-- CreateIndex
CREATE INDEX "ConversationParticipation_chatId_idx" ON "ConversationParticipation"("chatId");

-- AddForeignKey
ALTER TABLE "ConversationParticipation" ADD CONSTRAINT "ConversationParticipation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CommercialAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipation" ADD CONSTRAINT "ConversationParticipation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
