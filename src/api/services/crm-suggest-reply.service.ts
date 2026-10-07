import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException, InternalServerErrorException, NotFoundException } from '@exceptions';

import { AgentKnowledgeService } from './agent-knowledge.service';

const RECENT_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 600;
const REQUEST_TIMEOUT_MS = 130_000;

type ChatLine = { fromMe: boolean; text: string };

// LYD-68/LYD-69/LYD-70: sugerencia de respuesta con IA. Arma un contexto
// (instrucciones del agente + conocimiento activo + plantillas rapidas + la
// conversacion del chat abierto) y se lo pide a codex headless via el puente
// HTTP del host (deploy/lydia-prod/codex-bridge). No incluye mensajes de otros
// chats. Nunca envia nada: solo devuelve el texto para que el front lo copie
// al textarea.
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
    const context = await this.loadContext();
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
    const context = await this.loadContext();
    const prompt = this.buildPrompt({
      contactName: 'el cliente',
      conversation: [{ fromMe: false, text }],
      ...context,
    });
    return { suggestion: await this.askCodex(prompt) };
  }

  private async loadContext() {
    const [templates, knowledge, config] = await Promise.all([
      this.prisma.quickReplyTemplate.findMany({ orderBy: { command: 'asc' } }),
      this.knowledge.listActiveKnowledge(),
      this.knowledge.getInstructions(),
    ]);
    return {
      instructions: config.instructions,
      knowledge: knowledge.map((k) => `### ${k.title} (${k.category})\n${k.content}`),
      templates: templates.map((t) => `${t.command} (${t.label}):\n${t.body}`),
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

  private buildPrompt(input: {
    contactName: string;
    conversation: ChatLine[];
    instructions: string;
    knowledge: string[];
    templates: string[];
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
