-- LYD-74: etiquetas comerciales del agente IA por conversacion.
ALTER TABLE "Chat" ADD COLUMN "agentTags" JSONB;
