import { PrismaRepository } from '@api/repository/repository.service';
import { BadRequestException, InternalServerErrorException, NotFoundException } from '@exceptions';

import { AgentKnowledgeService } from './agent-knowledge.service';
import { AGENT_TAG_OPTIONS, mergeAiTags, readAgentTags } from './agent-tags';

const RECENT_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 600;
const AGENT_HISTORY_LIMIT = 12;
const MAX_AGENT_LINE_CHARS = 1000;
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

  // LYD-74: chat de la asesora con el agente (panel derecho del inbox). Cada
  // llamada manda el historial de ese chat; la ultima linea de la asesora es
  // la indicacion actual (sin ella = pedido del foco: sugerir respuesta). La
  // IA devuelve un mensaje para la asesora, opcionalmente una respuesta para
  // el cliente, y las etiquetas que detecta, que se guardan en el Chat.
  public async agentChat(chatId: string, input: { messages?: unknown }) {
    const chat = await this.prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) {
      throw new NotFoundException(`Conversation "${chatId}" not found`);
    }

    const history = this.agentHistory(input?.messages);
    const conversation = await this.recentConversation(chat.instanceId, chat.remoteJid);
    const currentTags = readAgentTags(chat.agentTags);
    const context = await this.loadContext();
    const contactName = chat.contactNameOverride ?? chat.name ?? 'el cliente';

    const prompt = [
      context.instructions,
      context.knowledge.length
        ? '## Informacion vigente de la empresa (usala como fuente principal)\n' + context.knowledge.join('\n\n')
        : '',
      '## Mensajes predeterminados de la empresa (informacion oficial y tono)',
      context.templates.join('\n\n---\n\n'),
      `## Conversacion actual con ${contactName}`,
      conversation.length
        ? conversation.map((line) => `${line.fromMe ? 'Asesora' : 'Cliente'}: ${line.text}`).join('\n')
        : '(todavia no hay mensajes)',
      '## Etiquetas actuales del lead',
      JSON.stringify(currentTags),
      '## Chat privado entre la asesora y tu (el cliente no lo ve)',
      history.length
        ? history.map((line) => `${line.role === 'asesora' ? 'Asesora' : 'Tu'}: ${line.text}`).join('\n')
        : '(sin indicaciones: sugiere la mejor respuesta al ultimo mensaje del cliente)',
      '## Tarea',
      [
        'Eres el asistente comercial de la asesora. Lee la conversacion y detecta la intencion del lead, su objecion,',
        'con quien hablamos y la siguiente mejor accion. Si la asesora te dio una indicacion, siguela.',
        'Cuando haya interes de compra, la respuesta para el cliente debe cerrar pidiendo un compromiso concreto',
        '(fecha y hora de visita, llamada, evaluacion, matricula o pago).',
        'Responde SOLO con un objeto JSON valido, sin texto fuera de el, con esta forma:',
        '{"mensaje": "1 o 2 frases para la asesora: lectura del lead y siguiente paso",',
        ' "respuesta_sugerida": "texto listo para enviar al cliente, o null si no corresponde",',
        ' "etiquetas": {"intencion": ..., "decisor": ..., "accion": ..., "fuente": ...}}',
        'En etiquetas usa exactamente uno de estos valores o null si no hay evidencia:',
        ...Object.entries(AGENT_TAG_OPTIONS).map(([group, options]) => `- ${group}: ${options.join(', ')}`),
      ].join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n');

    const parsed = this.parseAgentReply(await this.askCodex(prompt));
    const tags = mergeAiTags(currentTags, parsed.tags);
    if (JSON.stringify(tags) !== JSON.stringify(currentTags)) {
      await this.prisma.chat.update({ where: { id: chatId }, data: { agentTags: tags } });
    }
    return { reply: parsed.reply, suggestion: parsed.suggestion, tags };
  }

  private agentHistory(messages: unknown): { role: 'asesora' | 'ia'; text: string }[] {
    if (!Array.isArray(messages)) return [];
    return messages
      .filter(
        (m): m is { role: 'asesora' | 'ia'; text: string } =>
          (m?.role === 'asesora' || m?.role === 'ia') && typeof m?.text === 'string' && m.text.trim() !== '',
      )
      .slice(-AGENT_HISTORY_LIMIT)
      .map((m) => ({ role: m.role, text: m.text.trim().slice(0, MAX_AGENT_LINE_CHARS) }));
  }

  // La IA a veces envuelve el JSON en ```json o agrega una frase antes: se
  // toma el primer {...} del texto. Si no hay JSON valido, el texto entero va
  // como mensaje para la asesora, sin respuesta sugerida.
  private parseAgentReply(text: string): { reply: string; suggestion: string | null; tags: unknown } {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const body = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        const reply = typeof body.mensaje === 'string' ? body.mensaje.trim() : '';
        const suggestion =
          typeof body.respuesta_sugerida === 'string' && body.respuesta_sugerida.trim()
            ? body.respuesta_sugerida.trim()
            : null;
        if (reply || suggestion) return { reply, suggestion, tags: body.etiquetas };
      } catch {
        // cae al texto plano
      }
    }
    return { reply: text.trim(), suggestion: null, tags: null };
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
