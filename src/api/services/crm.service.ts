import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException, NotFoundException } from '@exceptions';
import { AgentRole, ChatStatus, Prisma } from '@prisma/client';
import { status as messageStatus } from '@utils/renderStatus';

import { AGENT_TAG_OPTIONS, applyTagPatch, readAgentTags } from './agent-tags';
import {
  ConversationChannel,
  decodeCursor,
  encodeCursor,
  messagePreview,
  NON_WHATSAPP_INTEGRATIONS,
} from './crm-conversations.util';
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

// LYD-79: clave de orden de la lista del inbox -- hora del ultimo mensaje y,
// para chats sin ningun mensaje (caso raro), la de su ultima modificacion.
const CHAT_SORT_KEY = Prisma.raw(`COALESCE(c."lastMessageAt", FLOOR(EXTRACT(EPOCH FROM c."updatedAt"))::int, 0)`);

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
  // LYD-31: instanceName es opcional -- sin el, se listan las conversaciones de
  // TODAS las instancias (canales) juntas, ordenadas por ultimo mensaje.
  //
  // LYD-79: el ultimo mensaje vive en Chat.lastMessageAt/lastMessageId (lo
  // mantienen triggers de Postgres), asi que la lista sale de una sola consulta
  // sobre Chat en vez de recorrer todos los mensajes. Con `limit` pagina por
  // cursor y devuelve { conversations, nextCursor }; sin `limit` devuelve el
  // array completo, como antes. Se ordena por el ultimo mensaje y no por
  // Chat.updatedAt: ese lo pisa Prisma con cualquier escritura a la fila
  // (incluido "marcar como leida"), y abrir un chat lo subia al tope.
  public async listConversations(params: {
    instanceName?: string;
    status?: ChatStatus;
    assignedAgentId?: string;
    channel?: ConversationChannel;
    q?: string;
    // LYD-96: etiqueta comercial `fuente` y campana/anuncio (Chat.attribution.campaign).
    source?: string;
    campaign?: string;
    limit?: number;
    cursor?: string;
  }) {
    const { instanceName, status, assignedAgentId, channel, limit } = params;

    if (instanceName) {
      const instance = await this.prisma.instance.findUnique({ where: { name: instanceName } });
      if (!instance) {
        throw new NotFoundException(`Instance "${instanceName}" not found`);
      }
    }

    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    if (params.cursor && !cursor) {
      throw new BadRequestException('cursor invalido');
    }

    const conditions: Prisma.Sql[] = [Prisma.sql`c."archived" = false`];
    if (status) conditions.push(Prisma.sql`c."status"::text = ${status}`);
    if (assignedAgentId) conditions.push(Prisma.sql`c."assignedAgentId" = ${assignedAgentId}`);
    if (instanceName) conditions.push(Prisma.sql`i."name" = ${instanceName}`);
    if (channel === 'messenger') conditions.push(Prisma.sql`i."integration" = 'FACEBOOK-MESSENGER'`);
    if (channel === 'instagram') conditions.push(Prisma.sql`i."integration" = 'INSTAGRAM'`);
    if (channel === 'tiktok') conditions.push(Prisma.sql`i."integration" = 'TIKTOK'`);
    if (channel === 'whatsapp') {
      conditions.push(Prisma.sql`i."integration" NOT IN (${Prisma.join([...NON_WHATSAPP_INTEGRATIONS])})`);
    }
    const source = AGENT_TAG_OPTIONS.fuente.find((option) => option === params.source);
    if (source) conditions.push(Prisma.sql`c."agentTags"->>'fuente' = ${source}`);
    const campaign = params.campaign?.trim();
    if (campaign) conditions.push(Prisma.sql`c."attribution"->>'campaign' = ${campaign}`);
    const term = params.q?.trim();
    if (term) {
      const pattern = `%${escapeLike(term)}%`;
      conditions.push(Prisma.sql`(
        c."name" ILIKE ${pattern}
        OR c."contactNameOverride" ILIKE ${pattern}
        OR c."contactPhoneOverride" ILIKE ${pattern}
        OR c."remoteJid" ILIKE ${pattern}
        OR EXISTS (
          SELECT 1 FROM "Contact" ct
          WHERE ct."instanceId" = c."instanceId" AND ct."remoteJid" = c."remoteJid" AND ct."pushName" ILIKE ${pattern}
        )
      )`);
    }
    if (cursor) conditions.push(Prisma.sql`(${CHAT_SORT_KEY}, c."id") < (${cursor.sortKey}, ${cursor.id})`);

    // Se pide uno de mas para saber si hay pagina siguiente.
    const rows = await this.prisma.$queryRaw<{ id: string; sortKey: number }[]>`
      SELECT c."id", ${CHAT_SORT_KEY} AS "sortKey"
      FROM "Chat" c
      JOIN "Instance" i ON i."id" = c."instanceId"
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY "sortKey" DESC, c."id" DESC
      ${limit ? Prisma.sql`LIMIT ${limit + 1}` : Prisma.empty}
    `;

    const page = limit ? rows.slice(0, limit) : rows;
    const conversations = await this.hydrateConversations(page.map((r) => r.id));

    if (!limit) return conversations;
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ sortKey: Number(last.sortKey), id: last.id }) : null;
    return { conversations, nextCursor };
  }

  // LYD-96: campanas/anuncios con conversaciones, para el filtro del inbox.
  public async listCampaigns() {
    const rows = await this.prisma.$queryRaw<
      { campaign: string; source: string; headline: string | null; platform: string | null; total: number }[]
    >`
      SELECT c."attribution"->>'campaign' AS campaign,
             MIN(c."attribution"->>'source') AS source,
             MAX(c."attribution"->>'headline') AS headline,
             MIN(c."attribution"->>'platform') AS platform,
             COUNT(*)::int AS total
      FROM "Chat" c
      WHERE c."archived" = false AND c."attribution"->>'campaign' IS NOT NULL
      GROUP BY c."attribution"->>'campaign'
      ORDER BY total DESC, campaign ASC
    `;
    return rows;
  }

  // Arma cada conversacion con su agente, instancia, contacto y ultimo
  // mensaje, respetando el orden de `ids`. Mismo formato de respuesta que
  // antes de LYD-79 (el front no cambia).
  private async hydrateConversations(ids: string[]) {
    if (!ids.length) return [];

    const chats = await this.prisma.chat.findMany({ where: { id: { in: ids } }, include: { Agent: true } });
    const instanceIds = [...new Set(chats.map((c) => c.instanceId))];
    const lastMessageIds = chats.map((c) => c.lastMessageId).filter((id): id is string => !!id);

    const [instances, contacts, lastMessages] = await Promise.all([
      this.prisma.instance.findMany({
        where: { id: { in: instanceIds } },
        select: { id: true, name: true, integration: true },
      }),
      this.prisma.contact.findMany({
        where: { instanceId: { in: instanceIds }, remoteJid: { in: chats.map((c) => c.remoteJid) } },
      }),
      this.prisma.message.findMany({
        where: { id: { in: lastMessageIds } },
        select: { id: true, message: true, messageTimestamp: true },
      }),
    ]);

    const instanceById = new Map(instances.map((i) => [i.id, i]));
    const contactByKey = new Map(contacts.map((c) => [`${c.instanceId}|${c.remoteJid}`, c]));
    const messageById = new Map(lastMessages.map((m) => [m.id, m]));
    const chatById = new Map(chats.map((c) => [c.id, c]));

    return ids
      .map((id) => chatById.get(id))
      .filter((chat): chat is (typeof chats)[number] => !!chat)
      .map((chat) => {
        const instance = instanceById.get(chat.instanceId);
        const message = chat.lastMessageId ? messageById.get(chat.lastMessageId) : undefined;
        return {
          ...chat,
          instanceName: instance?.name,
          integration: instance?.integration,
          contact: contactByKey.get(`${chat.instanceId}|${chat.remoteJid}`) ?? null,
          lastMessage: message
            ? { content: messagePreview(message.message), timestamp: message.messageTimestamp }
            : null,
        };
      });
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
  // identifica por instanceId + key.remoteJid), asi que hay que borrarlos aparte;
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
