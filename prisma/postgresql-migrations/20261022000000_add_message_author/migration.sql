-- LYD-101: autoria de los mensajes salientes y sedes de cada asesora.

-- CreateEnum
CREATE TYPE "MessageAuthorKind" AS ENUM ('asesora', 'bot', 'bienvenida');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "sedes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "MessageAuthor" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "messageKeyId" VARCHAR(255) NOT NULL,
    "kind" "MessageAuthorKind" NOT NULL,
    "agentId" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAuthor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageAuthor_instanceId_messageKeyId_key" ON "MessageAuthor"("instanceId", "messageKeyId");

-- CreateIndex
CREATE INDEX "MessageAuthor_agentId_createdAt_idx" ON "MessageAuthor"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "MessageAuthor" ADD CONSTRAINT "MessageAuthor_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
