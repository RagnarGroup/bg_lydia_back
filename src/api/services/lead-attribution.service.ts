import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { Prisma } from '@prisma/client';

import { AgentTags, readAgentTags } from './agent-tags';
import { LeadAttribution, readAttribution, tikTokAttribution } from './lead-attribution.util';

const logger = new Logger('LeadAttribution');

// LYD-96: guarda el origen del lead en la conversacion. Primer toque gana: si el
// Chat ya tiene atribucion no se pisa (un segundo anuncio no reescribe el
// origen). La etiqueta comercial `fuente` solo se fija si esta vacia -- una
// fuente puesta a mano por la asesora (o la IA) nunca se sobrescribe, pero el
// detalle de campana igual queda guardado en Chat.attribution.
export async function recordLeadAttribution(
  prisma: PrismaRepository,
  instanceId: string,
  remoteJid: string,
  attribution: LeadAttribution,
): Promise<boolean> {
  const chat = await prisma.chat.findUnique({
    where: { instanceId_remoteJid: { instanceId, remoteJid } },
    select: { id: true, attribution: true, agentTags: true },
  });

  if (readAttribution(chat?.attribution)) return false;

  const tags: AgentTags = readAgentTags(chat?.agentTags);
  if (!tags.fuente) tags.fuente = attribution.source;
  const data = {
    attribution: attribution as unknown as Prisma.InputJsonObject,
    agentTags: tags as Prisma.InputJsonObject,
  };

  await prisma.chat.upsert({
    where: { instanceId_remoteJid: { instanceId, remoteJid } },
    create: { instanceId, remoteJid, ...data },
    update: data,
  });
  return true;
}

// El mensaje recien guardado es el unico entrante de la conversacion.
export async function isFirstInboundMessage(
  prisma: PrismaRepository,
  instanceId: string,
  remoteJid: string,
): Promise<boolean> {
  const rows: { count: number }[] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count FROM "Message"
    WHERE "instanceId" = ${instanceId}
    AND "key"->>'remoteJid' = ${remoteJid}
    AND ("key"->>'fromMe')::boolean = false
  `;
  return (rows[0]?.count ?? 0) <= 1;
}

// Punto de entrada de los canales: el referral de un anuncio de Meta (si vino)
// tiene prioridad; si no, el codigo [TT-...] solo cuenta en el PRIMER mensaje
// entrante de la conversacion. Es best-effort: un fallo no debe tirar el mensaje.
export async function attributeInboundMessage(
  prisma: PrismaRepository,
  instanceId: string,
  remoteJid: string,
  input: { platform: string; text?: string; referral?: LeadAttribution },
): Promise<LeadAttribution | undefined> {
  try {
    let attribution = input.referral;
    if (!attribution) {
      const candidate = tikTokAttribution(input.text, input.platform);
      if (candidate && (await isFirstInboundMessage(prisma, instanceId, remoteJid))) attribution = candidate;
    }
    if (!attribution) return undefined;
    return (await recordLeadAttribution(prisma, instanceId, remoteJid, attribution)) ? attribution : undefined;
  } catch (error) {
    logger.error(`No se pudo guardar la atribucion de ${remoteJid}: ${error}`);
    return undefined;
  }
}
