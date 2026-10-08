import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException, NotFoundException } from '@exceptions';
import { AgentRole, ChatStatus, Prisma } from '@prisma/client';
import { status as messageStatus } from '@utils/renderStatus';

import { applyTagPatch, readAgentTags } from './agent-tags';
import { buildSnippet, escapeLike, normalizeSearchLimit, SEARCH_MIN_LENGTH } from './crm-search.util';

// LYD-60: texto buscable de un mensaje -- texto plano, texto extendido
// (respuestas/links) y caption/nombre de archivo de los adjuntos. Tiene que
// quedar identica a la expresion del indice trigram de la migracion
// 20260928000000_add_message_search_trgm (sin el alias "m").
const MESSAGE_SEARCH_TEXT = Prisma.raw(`COALESCE(
  m."message"->>'conversation',
  m."message"->'extendedTextMessage'->>'text',
  m."message"->'imageMessage'->>'caption',
  m."message"->'videoMessage'->>'caption',
  m."message"->'documentMessage'->>'caption',
  m."message"->'documentMessage'->>'fileName',
  ''
)`);

type SearchMessageRow = {
  messageId: string;
  timestamp: number;
  fromMe: boolean;
  pushName: string | null;
  text: string;
  chatId: string;
  remoteJid: string;
  chatName: string | null;
  contactNameOverride: string | null;
  contactPhoneOverride: string | null;
  instanceName: string;
  integration: string;
  contactPushName: string | null;
  profilePicUrl: string | null;
};

// CRM-12: capa de agentes humanos sobre las conversaciones de WhatsApp que
// ya persiste Evolution API (Chat/Contact/Message). No reimplementa nada de
// eso -- solo agrega lo que daba Chatwoot: asignacion de agente, estado de
// atencion (open/pending/resolved) y notas internas.
export class CrmService {
  constructor(private readonly prisma: PrismaRepository) {}

  public async listAgents() {
    return this.prisma.agent.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  }

  public async createAgent(data: { name: string; email?: string; color?: string; role?: AgentRole }) {
    if (!data?.name) {
      throw new BadRequestException('name is required');
    }
    return this.prisma.agent.create({ data });
  }

  // Chat y Contact no tienen relacion FK entre si en el schema de Evolution
  // (ambos son unique por [instanceId, remoteJid] pero independientes) --
  // se cruzan a mano aca en vez de duplicar el contacto en una tabla propia.
  //
  // LYD-31: instanceName ahora es opcional -- sin el, se listan las conversaciones
  // de TODAS las instancias (canales) juntas, mezcladas y ordenadas por ultimo
  // mensaje. remoteJid solo es unico dentro de una instancia (dos canales podrian
  // en teoria compartir el mismo valor), asi que contactos y ultimo mensaje se
  // resuelven por instancia, no en una sola consulta cruzada.
  public async listConversations(params: { instanceName?: string; status?: ChatStatus; assignedAgentId?: string }) {
    const { instanceName, status, assignedAgentId } = params;

    let instances: { id: string; name: string; integration: string }[];
    if (instanceName) {
      const instance = await this.prisma.instance.findUnique({ where: { name: instanceName } });
      if (!instance) {
        throw new NotFoundException(`Instance "${instanceName}" not found`);
      }
      instances = [instance];
    } else {
      instances = await this.prisma.instance.findMany();
    }

    const byInstance = await Promise.all(
      instances.map(async (instance) => {
        // Sin orderBy aca a proposito: Chat.updatedAt es @updatedAt de Prisma, se pisa con
        // cualquier escritura a la fila -- incluido el PATCH de "marcar como leida" al abrir
        // la conversacion (unreadMessages: 0). Ordenar por eso hacia que abrir un chat lo
        // subiera al tope aunque no hubiera mensaje nuevo. El orden real se calcula al final,
        // por el timestamp del ultimo mensaje, que solo cambia cuando llega o se envia uno.
        const chats = await this.prisma.chat.findMany({
          where: {
            instanceId: instance.id,
            // LYD-40: "cerradas" (archivadas) no aparecen en la lista
            // principal del inbox -- reversible, el historial sigue ahi.
            archived: false,
            ...(status ? { status } : {}),
            ...(assignedAgentId ? { assignedAgentId } : {}),
          },
          include: { Agent: true },
        });

        const remoteJids = chats.map((c) => c.remoteJid);
        const contacts = remoteJids.length
          ? await this.prisma.contact.findMany({
              where: { instanceId: instance.id, remoteJid: { in: remoteJids } },
            })
          : [];
        const contactByJid = new Map(contacts.map((c) => [c.remoteJid, c]));
        const lastMessageByJid = await this.lastMessageByRemoteJid(instance.id, remoteJids);

        return chats.map((chat) => ({
          ...chat,
          instanceName: instance.name,
          integration: instance.integration,
          contact: contactByJid.get(chat.remoteJid) ?? null,
          lastMessage: lastMessageByJid.get(chat.remoteJid) ?? null,
        }));
      }),
    );

    return byInstance.flat().sort((a, b) => {
      // Chats sin ningun mensaje (recien creados, caso raro) van al final por updatedAt.
      const ta = a.lastMessage?.timestamp ?? Math.floor(a.updatedAt?.getTime() / 1000);
      const tb = b.lastMessage?.timestamp ?? Math.floor(b.updatedAt?.getTime() / 1000);
      return tb - ta;
    });
  }

  // Message.key es JSON (no hay columna remoteJid propia) -- no hay forma de
  // pedirle a Prisma "el mas nuevo por remoteJid" en una sola query sin SQL
  // crudo. Con el volumen de mensajes de una instancia nueva esto alcanza;
  // si el historial crece mucho, esto se vuelve candidato a reemplazar por
  // un SELECT DISTINCT ON (key->>'remoteJid') ... ORDER BY messageTimestamp
  // DESC con indice dedicado.
  private async lastMessageByRemoteJid(instanceId: string, remoteJids: string[]) {
    const result = new Map<string, { content: string; timestamp: number }>();
    if (!remoteJids.length) return result;

    const messages = await this.prisma.message.findMany({
      where: {
        instanceId,
        OR: remoteJids.map((remoteJid) => ({ key: { path: ['remoteJid'], equals: remoteJid } })),
      },
      orderBy: { messageTimestamp: 'desc' },
      select: { key: true, message: true, messageTimestamp: true },
    });

    for (const m of messages) {
      const remoteJid = (m.key as { remoteJid?: string })?.remoteJid;
      if (!remoteJid || result.has(remoteJid)) continue; // ya ordenado desc: el primero que aparece es el mas nuevo
      const body = m.message as { conversation?: string; extendedTextMessage?: { text?: string } };
      const content = body?.conversation ?? body?.extendedTextMessage?.text ?? this.mediaPreviewLabel(m.message);
      result.set(remoteJid, { content, timestamp: m.messageTimestamp });
    }
    return result;
  }

  // LYD-15: sin esto, un mensaje que es solo una foto/audio/documento (sin
  // texto) mostraba el preview de "Ultimo mensaje" vacio en la lista de
  // conversaciones.
  private mediaPreviewLabel(message: unknown): string {
    const body = message as Record<string, unknown>;
    if (body?.imageMessage) return 'Foto';
    if (body?.videoMessage) return 'Video';
    if (body?.audioMessage) return 'Audio';
    if (body?.documentMessage) return 'Documento';
    if (body?.stickerMessage) return 'Sticker';
    return '';
  }

  // LYD-60: busqueda contextual dentro de los mensajes (estilo WhatsApp).
  // SQL crudo porque el texto vive dentro del JSON de Message.message (no hay
  // columna body/caption propia) y hay que cruzar con Chat por
  // key->>'remoteJid', igual que en updateConversation. La expresion de texto
  // (MESSAGE_SEARCH_TEXT) es la misma que la del indice trigram.
  public async searchMessages(params: { q?: string; instanceName?: string; limit?: unknown }) {
    const term = params.q?.trim() ?? '';
    if (term.length < SEARCH_MIN_LENGTH) {
      throw new BadRequestException(`q debe tener al menos ${SEARCH_MIN_LENGTH} caracteres`);
    }
    const limit = normalizeSearchLimit(params.limit);
    const pattern = `%${escapeLike(term)}%`;

    // Solo conversaciones visibles en el inbox (archived = false, LYD-40): un
    // resultado de un chat archivado no se podria abrir desde la lista.
    const rows = await this.prisma.$queryRaw<SearchMessageRow[]>`
      SELECT
        m."id" AS "messageId",
        m."messageTimestamp" AS "timestamp",
        COALESCE((m."key"->>'fromMe')::boolean, false) AS "fromMe",
        m."pushName" AS "pushName",
        ${MESSAGE_SEARCH_TEXT} AS "text",
        c."id" AS "chatId",
        c."remoteJid" AS "remoteJid",
        c."name" AS "chatName",
        c."contactNameOverride" AS "contactNameOverride",
        c."contactPhoneOverride" AS "contactPhoneOverride",
        i."name" AS "instanceName",
        i."integration" AS "integration",
        ct."pushName" AS "contactPushName",
        ct."profilePicUrl" AS "profilePicUrl"
      FROM "Message" m
      JOIN "Chat" c ON c."instanceId" = m."instanceId" AND c."remoteJid" = m."key"->>'remoteJid'
      JOIN "Instance" i ON i."id" = m."instanceId"
      LEFT JOIN "Contact" ct ON ct."instanceId" = c."instanceId" AND ct."remoteJid" = c."remoteJid"
      WHERE ${MESSAGE_SEARCH_TEXT} ILIKE ${pattern}
        AND c."archived" = false
        ${params.instanceName ? Prisma.sql`AND i."name" = ${params.instanceName}` : Prisma.empty}
      ORDER BY m."messageTimestamp" DESC
      LIMIT ${limit}
    `;

    return {
      query: term,
      messages: rows.map(({ text, ...row }) => ({
        ...row,
        timestamp: Number(row.timestamp),
        snippet: buildSnippet(text, term),
      })),
    };
  }

  public async getConversation(chatId: string) {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      include: { Agent: true, Note: { orderBy: { createdAt: 'asc' }, include: { Agent: true } }, Instance: true },
    });
    if (!chat) {
      throw new NotFoundException(`Conversation "${chatId}" not found`);
    }
    const contact = await this.prisma.contact.findFirst({
      where: { instanceId: chat.instanceId, remoteJid: chat.remoteJid },
    });
    // LYD-31: instanceName/integration van sueltos (no solo dentro de Instance) porque
    // el front los necesita para saber contra que canal mandar los mensajes/media.
    return {
      ...chat,
      instanceName: chat.Instance.name,
      integration: chat.Instance.integration,
      contact: contact ?? null,
    };
  }

  public async updateConversation(
    chatId: string,
    data: {
      status?: ChatStatus;
      assignedAgentId?: string | null;
      unreadMessages?: number;
      contactNameOverride?: string | null;
      contactPhoneOverride?: string | null;
      archived?: boolean;
      agentTags?: unknown;
    },
  ) {
    const chat = await this.assertChatExists(chatId);

    if (data.assignedAgentId) {
      const agent = await this.prisma.agent.findUnique({ where: { id: data.assignedAgentId } });
      if (!agent) {
        throw new BadRequestException(`Agent "${data.assignedAgentId}" not found`);
      }
    }

    // unreadMessages es de Evolution API (Chat.unreadMessages), no algo propio
    // de CRM -- lo unico que necesita el frontend es poder ponerlo en 0 al
    // abrir la conversacion (LYD-13). No se expone para setearlo a cualquier
    // valor arbitrario.
    if (data.unreadMessages !== undefined && data.unreadMessages !== 0) {
      throw new BadRequestException('unreadMessages solo puede setearse a 0');
    }

    // Chat.unreadMessages no es la fuente de verdad -- whatsapp.baileys.service
    // (updateChatUnreadMessages) lo recalcula de cero contando Message.status
    // = DELIVERY_ACK cada vez que llega un mensaje nuevo. Poner solo el
    // contador en 0 sin tocar el status de los mensajes hacia que el badge
    // volviera a "resucitar" con todos los mensajes viejos + el nuevo en
    // cuanto entraba cualquier mensaje siguiente (bug reportado en LYD-13).
    if (data.unreadMessages === 0) {
      await this.prisma.$executeRaw`
        UPDATE "Message"
        SET "status" = ${messageStatus[4]}
        WHERE "instanceId" = ${chat.instanceId}
        AND "key"->>'remoteJid' = ${chat.remoteJid}
        AND ("key"->>'fromMe')::boolean = false
        AND ("status" IS NULL OR "status" = ${messageStatus[3]})
      `;
    }

    // LYD-14: string vacio limpia el override (vuelve a mostrar el nombre/
    // numero nativo de WhatsApp), no se guarda como "".
    if (data.contactNameOverride !== undefined) {
      data.contactNameOverride = data.contactNameOverride?.trim() || null;
    }
    if (data.contactPhoneOverride !== undefined) {
      data.contactPhoneOverride = data.contactPhoneOverride?.trim() || null;
    }

    const { agentTags: agentTagsPatch, ...fields } = data;
    // LYD-74: correccion manual de las etiquetas del agente IA -- se mezcla
    // con lo guardado (solo cambian los grupos que vienen en el body).
    const agentTags =
      agentTagsPatch !== undefined
        ? (applyTagPatch(readAgentTags(chat.agentTags), agentTagsPatch) as Prisma.InputJsonObject)
        : undefined;

    return this.prisma.chat.update({
      where: { id: chatId },
      data: { ...fields, agentTags },
      include: { Agent: true },
    });
  }

  public async listNotes(chatId: string) {
    await this.assertChatExists(chatId);
    return this.prisma.conversationNote.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
      include: { Agent: true },
    });
  }

  public async addNote(chatId: string, data: { content: string; agentId?: string }) {
    await this.assertChatExists(chatId);
    if (!data?.content?.trim()) {
      throw new BadRequestException('content is required');
    }
    return this.prisma.conversationNote.create({
      data: { chatId, content: data.content, agentId: data.agentId ?? null },
      include: { Agent: true },
    });
  }

  // LYD-40: borrado real (Chat + Message) -- distinto de "archivar"
  // (Chat.archived), que es reversible. Message no tiene FK a Chat (se
  // identifica por instanceId + key.remoteJid, igual que en
  // lastMessageByRemoteJid mas arriba), asi que hay que borrarlos aparte;
  // ConversationNote sale solo por el onDelete: Cascade del schema.
  //
  // Se bloquea si hay un Lead vinculado -- Lead.chatId no tiene cascada
  // (a proposito, ver schema) para no destruir informacion de pipeline
  // comercial sin que alguien lo decida a mano primero.
  // LYD-77: la asesora que responde un chat sin responsable queda asignada.
  // El update es condicional (assignedAgentId null) para que dos asesoras
  // respondiendo a la vez no se pisen y para que un chat ya asignado solo
  // cambie de dueño a mano (updateConversation). El lead del chat sigue la
  // misma regla.
  public async claimConversation(chatId: string, agentId?: string) {
    await this.assertChatExists(chatId);
    if (!agentId) {
      throw new BadRequestException('agentId is required');
    }
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new BadRequestException(`Agent "${agentId}" not found`);
    }

    await this.prisma.chat.updateMany({
      where: { id: chatId, assignedAgentId: null },
      data: { assignedAgentId: agentId },
    });
    await this.prisma.lead.updateMany({
      where: { chatId, assignedAgentId: null },
      data: { assignedAgentId: agentId },
    });

    return this.prisma.chat.findUnique({ where: { id: chatId }, include: { Agent: true } });
  }

  public async deleteConversation(chatId: string) {
    const chat = await this.assertChatExists(chatId);

    // LYD-63: el lead vinculado se borra junto con la conversacion (presupuesto,
    // etapa, observaciones y sus eventos de calendario). Todo en una sola
    // transaccion para no dejar datos huerfanos si algo falla a medias. Las
    // notas internas caen solas por el onDelete: Cascade de ConversationNote.
    await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({ where: { chatId } });
      if (lead) {
        await tx.calendarEvent.deleteMany({ where: { leadId: lead.id } });
        await tx.lead.delete({ where: { id: lead.id } });
      }

      await tx.message.deleteMany({
        where: { instanceId: chat.instanceId, key: { path: ['remoteJid'], equals: chat.remoteJid } },
      });
      await tx.chat.delete({ where: { id: chatId } });
    });
  }

  private async assertChatExists(chatId: string) {
    const chat = await this.prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) {
      throw new NotFoundException(`Conversation "${chatId}" not found`);
    }
    return chat;
  }
}
