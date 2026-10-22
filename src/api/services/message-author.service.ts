import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import { MessageAuthorKind } from '@prisma/client';

// LYD-101: autoria de los mensajes salientes. Evolution guarda todo lo que
// sale como fromMe=true, sin distinguir asesora, bot o bienvenida; esta tabla
// lo agrega sin tocar Message. La auditoria comercial diaria (LYD-102) la
// cruza con Message por instanceId + key.id.
export class MessageAuthorService {
  private readonly logger = new Logger('MessageAuthorService');

  constructor(private readonly prisma: PrismaRepository) {}

  // Envio desde el inbox de Lydia: el front manda el agentId de la sesion y
  // el key.id que devolvio el envio.
  public async recordAgentMessage(data: { instanceName?: string; messageKeyId?: string; agentId?: string }) {
    const { instanceName, messageKeyId, agentId } = data ?? {};
    if (!instanceName || !messageKeyId || !agentId) {
      throw new BadRequestException('instanceName, messageKeyId y agentId son requeridos');
    }

    const instance = await this.prisma.instance.findUnique({ where: { name: instanceName }, select: { id: true } });
    if (!instance) {
      throw new NotFoundException(`Instancia ${instanceName} no encontrada`);
    }

    const agent = await this.prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
    if (!agent) {
      throw new NotFoundException(`Agente ${agentId} no encontrado`);
    }

    return this.upsert(instance.id, messageKeyId, MessageAuthorKind.asesora, agentId);
  }

  // Envios automaticos (bot, bienvenida) desde los canales. `sent` es lo que
  // devuelve textMessage/buttonMessage (el messageRaw con su key). Best-effort:
  // el mensaje ya salio, un fallo aca no debe romper el flujo del canal.
  public async recordAutomatic(instanceId: string, sent: unknown, kind: MessageAuthorKind): Promise<void> {
    const messageKeyId = (sent as { key?: { id?: unknown } } | null)?.key?.id;
    if (typeof messageKeyId !== 'string' || !messageKeyId) {
      return;
    }

    try {
      await this.upsert(instanceId, messageKeyId, kind, null);
    } catch (error) {
      this.logger.error(`No se pudo registrar la autoria (${kind}) de ${messageKeyId}: ${error}`);
    }
  }

  // Idempotente: reintentar el registro de un mismo mensaje no duplica ni
  // cambia el autor ya guardado.
  private upsert(instanceId: string, messageKeyId: string, kind: MessageAuthorKind, agentId: string | null) {
    return this.prisma.messageAuthor.upsert({
      where: { instanceId_messageKeyId: { instanceId, messageKeyId } },
      create: { instanceId, messageKeyId, kind, agentId },
      update: {},
    });
  }
}
