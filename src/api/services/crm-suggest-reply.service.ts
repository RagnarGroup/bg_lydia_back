import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException, InternalServerErrorException, NotFoundException } from '@exceptions';
import { Prisma } from '@prisma/client';

import { AgentKnowledgeService } from './agent-knowledge.service';

const RECENT_MESSAGES = 20;
const EXAMPLE_REPLIES = 5;
const MAX_MESSAGE_CHARS = 600;
const REQUEST_TIMEOUT_MS = 130_000;

// Palabras que no aportan para buscar respuestas parecidas de asesoras.
const STOPWORDS = new Set([
  'hola',
  'buenas',
  'buenos',
  'dias',
  'tardes',
  'noches',
  'como',
  'estas',
  'para',
  'pero',
  'porque',
  'que',
  'quiero',
  'quisiera',
  'necesito',
  'puedo',
  'puede',
  'favor',
  'gracias',
  'saber',
  'tengo',
  'tiene',
  'tienen',
  'este',
  'esta',
  'estoy',
  'muy',
  'con',
  'una',
  'uno',
  'los',
  'las',
  'del',
  'por',
  'mas',
]);

type ChatLine = { fromMe: boolean; text: string };

// LYD-68: sugerencia de respuesta con IA. Arma un contexto (conversacion
// reciente + plantillas rapidas + respuestas previas de asesoras a mensajes
// parecidos + base de conocimiento fija) y se lo pide a codex headless via el
// puente HTTP del host (deploy/lydia-prod/codex-bridge). Nunca envia nada:
// solo devuelve el texto para que el front lo copie al textarea.
export class CrmSuggestReplyService {
  constructor(
    private readonly prisma: PrismaRepository,
    private readonly knowledge: AgentKnowledgeService,
  ) {}

  public async suggestReply(chatId: string) {
    const chat = await this.prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) {
      throw new NotFoundException(`Conversation "${chatId}" not found`);
    }

    const conversation = await this.recentConversation(chat.instanceId, chat.remoteJid);
    const lastIncoming = [...conversation].reverse().find((line) => !line.fromMe);
    if (!lastIncoming) {
      throw new InternalServerErrorException('La conversacion no tiene mensajes del cliente para responder');
    }

    const contactName = chat.contactNameOverride ?? chat.name ?? 'el cliente';
    const context = await this.loadContext(lastIncoming.text, { instanceId: chat.instanceId, chatId: chat.id });
    const prompt = this.buildPrompt({ contactName, conversation, ...context });

    return { suggestion: await this.askCodex(prompt) };
  }

  // LYD-69: prueba desde la pantalla "Agente" -- una sugerencia para un mensaje
  // de cliente escrito a mano, con el mismo conocimiento que usaria un chat real.
  public async suggestForMessage(message: unknown) {
    const text = typeof message === 'string' ? message.trim().slice(0, MAX_MESSAGE_CHARS) : '';
    if (!text) {
      throw new BadRequestException('message is required');
    }
    const context = await this.loadContext(text, {});
    const prompt = this.buildPrompt({
      contactName: 'el cliente',
      conversation: [{ fromMe: false, text }],
      ...context,
    });
    return { suggestion: await this.askCodex(prompt) };
  }

  private async loadContext(incomingText: string, scope: { instanceId?: string; chatId?: string }) {
    const [templates, examples, knowledge, config] = await Promise.all([
      this.prisma.quickReplyTemplate.findMany({ orderBy: { command: 'asc' } }),
      this.similarAgentReplies(incomingText, scope),
      this.knowledge.listActiveKnowledge(),
      this.knowledge.getInstructions(),
    ]);
    return {
      instructions: config.instructions,
      knowledge: knowledge.map((k) => `### ${k.title} (${k.category})\n${k.content}`),
      templates: templates.map((t) => `${t.command} (${t.label}):\n${t.body}`),
      examples,
    };
  }

  private async recentConversation(instanceId: string, remoteJid: string): Promise<ChatLine[]> {
    const messages = await this.prisma.message.findMany({
      where: { instanceId, key: { path: ['remoteJid'], equals: remoteJid } },
      orderBy: { messageTimestamp: 'desc' },
      take: RECENT_MESSAGES,
      select: { key: true, message: true },
    });

    return messages
      .reverse()
      .map((m) => ({
        fromMe: (m.key as { fromMe?: boolean })?.fromMe === true,
        text: this.messageText(m.message),
      }))
      .filter((line) => line.text);
  }

  private messageText(message: unknown): string {
    const body = (message ?? {}) as Record<string, any>;
    const text =
      body.conversation ??
      body.extendedTextMessage?.text ??
      body.imageMessage?.caption ??
      body.videoMessage?.caption ??
      body.documentMessage?.caption;
    if (text) return String(text).slice(0, MAX_MESSAGE_CHARS);
    if (body.imageMessage) return '[Foto]';
    if (body.audioMessage) return '[Nota de voz]';
    if (body.documentMessage) return '[Documento]';
    if (body.videoMessage) return '[Video]';
    return '';
  }

  // Respuestas reales de asesoras en OTRAS conversaciones que mencionan las
  // mismas palabras clave que el ultimo mensaje del cliente. Es la parte
  // "retrieval" del RAG de prueba: busqueda por palabras, sin embeddings.
  private async similarAgentReplies(
    incomingText: string,
    scope: { instanceId?: string; chatId?: string },
  ): Promise<string[]> {
    const keywords = [
      ...new Set(
        incomingText
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
      ),
    ].slice(0, 5);
    if (!keywords.length) return [];

    const patterns = keywords.map((k) => Prisma.sql`lower(t.value) LIKE ${`%${k}%`}`);
    const rows = await this.prisma.$queryRaw<{ text: string }[]>(Prisma.sql`
      SELECT t.value AS text
      FROM "Message" m
      JOIN "Chat" c ON c."instanceId" = m."instanceId" AND c."remoteJid" = m."key"->>'remoteJid'
      CROSS JOIN LATERAL (
        SELECT COALESCE(m."message"->>'conversation', m."message"->'extendedTextMessage'->>'text', '') AS value
      ) AS t
      WHERE ${scope.instanceId ? Prisma.sql`m."instanceId" = ${scope.instanceId}` : Prisma.sql`TRUE`}
        AND ${scope.chatId ? Prisma.sql`c.id <> ${scope.chatId}` : Prisma.sql`TRUE`}
        AND m."key"->>'fromMe' = 'true'
        AND length(t.value) BETWEEN 40 AND ${MAX_MESSAGE_CHARS}
        AND (${Prisma.join(patterns, ' OR ')})
      ORDER BY m."messageTimestamp" DESC
      LIMIT ${EXAMPLE_REPLIES}
    `);
    return rows.map((r) => r.text);
  }

  private buildPrompt(input: {
    contactName: string;
    conversation: ChatLine[];
    instructions: string;
    knowledge: string[];
    templates: string[];
    examples: string[];
  }): string {
    const transcript = input.conversation
      .map((line) => `${line.fromMe ? 'Asesora' : 'Cliente'}: ${line.text}`)
      .join('\n');

    return [
      input.instructions,
      input.knowledge.length
        ? '## Informacion vigente de la empresa (usala como fuente principal)\n' + input.knowledge.join('\n\n')
        : '',
      '## Mensajes predeterminados de la empresa (informacion oficial y tono)',
      input.templates.join('\n\n---\n\n'),
      input.examples.length
        ? '## Respuestas reales de asesoras a consultas parecidas (solo como referencia de estilo)\n' +
          input.examples.map((e, i) => `Ejemplo ${i + 1}: ${e}`).join('\n\n')
        : '',
      `## Conversacion actual con ${input.contactName}`,
      transcript,
      '## Tarea',
      'Escribe UNA sola respuesta que la asesora pueda enviar ahora al ultimo mensaje del cliente. ' +
        'Devuelve unicamente el texto del mensaje, sin comillas, sin explicaciones ni encabezados.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async askCodex(prompt: string): Promise<string> {
    const url = process.env.CODEX_BRIDGE_URL;
    const token = process.env.CODEX_BRIDGE_TOKEN;
    if (!url || !token) {
      throw new InternalServerErrorException('Falta configurar CODEX_BRIDGE_URL y CODEX_BRIDGE_TOKEN');
    }

    let res: Response;
    try {
      res = await fetch(`${url.replace(/\/$/, '')}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new InternalServerErrorException('No se pudo contactar al servicio de IA (codex bridge)');
    }

    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok || !body.text) {
      throw new InternalServerErrorException(`El servicio de IA fallo: ${body.error ?? `HTTP ${res.status}`}`);
    }
    return body.text.trim();
  }
}
