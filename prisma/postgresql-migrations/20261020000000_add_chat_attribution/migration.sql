-- LYD-96: origen del lead (fuente, campana/anuncio) en Chat.

-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "attribution" JSONB;

-- CreateIndex
CREATE INDEX "Chat_attribution_campaign_idx" ON "Chat" (("attribution"->>'campaign'));
