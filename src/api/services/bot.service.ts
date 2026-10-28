import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';

import { BOT_LIMITS, BotGraph, validateBotGraph } from './bot-flow.validation';

// Canal por el que el motor habla con el cliente (hoy solo Cloud API; ver
// whatsapp.business.service.ts). Se inyecta para que el motor no dependa de
// un canal concreto.
export interface BotSender {
  sendText(text: string): Promise<void>;
  sendButtons(body: string, buttons: { id: string; title: string }[]): Promise<void>;
}

export type BotInbound = { kind: 'button'; buttonId: string } | { kind: 'other' };

// Ids de los botones: "bot:<nodo>:<opcion>". Llevan el nodo para poder
// ignorar botones de una pregunta vieja (el cliente puede tocar un boton de
// un mensaje anterior).
const BUTTON_PREFIX = 'bot:';
// Tope de pasos por ejecucion: red de seguridad ante un grafo mal formado
// aunque la validacion ya prohibe ciclos. Igual al maximo de nodos (no
// menor) para que un flujo valido de puro mensajes nunca se corte a mitad.
const MAX_STEPS = BOT_LIMITS.maxNodes;

const EMPTY_GRAPH: BotGraph = { startNodeId: null, nodes: [], edges: [] };

// LYD-47: configuracion (CRUD del flujo) + motor de ejecucion del bot.
export class BotService {
  private readonly logger = new Logger('BotService');

  constructor(private readonly prisma: PrismaRepository) {}

  // ---------- Configuracion ----------

  public async getFlow(instanceName: string) {
    const instance = await this.findInstance(instanceName);
    const flow = await this.prisma.botFlow.findUnique({ where: { instanceId: instance.id } });

    if (flow) {
      const parsed = validateBotGraph(flow.graph);
      return {
        instanceName: instance.name,
        enabled: flow.enabled,
        graph: (parsed.graph ?? EMPTY_GRAPH) as BotGraph,
        warnings: parsed.warnings,
      };
    }

    // Sin flujo guardado todavia: se arma uno de un solo paso a partir del
    // mensaje de bienvenida que ya existia (LYD-35), para no perderlo.
    const welcome = await this.prisma.welcomeMessageConfig.findUnique({ where: { instanceId: instance.id } });
    const graph: BotGraph = welcome?.message?.trim()
      ? {
          startNodeId: 'welcome',
          nodes: [{ id: 'welcome', type: 'message', text: welcome.message.trim(), x: 0, y: 0 }],
          edges: [],
        }
      : EMPTY_GRAPH;
    return { instanceName: instance.name, enabled: welcome?.enabled ?? false, graph, warnings: [] as string[] };
  }

  public async saveFlow(instanceName: string, data: { enabled?: boolean; graph?: unknown }) {
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }
    const instance = await this.findInstance(instanceName);
    const existing = await this.prisma.botFlow.findUnique({ where: { instanceId: instance.id } });

    let graph: BotGraph;
    let warnings: string[] = [];
    if (data.graph !== undefined) {
      const result = validateBotGraph(data.graph);
      if (!result.graph) {
        throw new BadRequestException(result.errors.join(' | '));
      }
      graph = result.graph;
      warnings = result.warnings;
    } else {
      graph = ((await this.getFlow(instanceName)).graph ?? EMPTY_GRAPH) as BotGraph;
    }

    const enabled = data.enabled ?? existing?.enabled ?? false;
    if (enabled && (!graph.startNodeId || graph.nodes.length === 0)) {
      throw new BadRequestException('No se puede activar el bot sin ningun paso');
    }

    const flow = await this.prisma.botFlow.upsert({
      where: { instanceId: instance.id },
      create: { instanceId: instance.id, enabled, graph: graph as object },
      update: { enabled, graph: graph as object },
    });

    // Baileys (canal QR) no tiene botones interactivos y sigue leyendo el
    // mensaje de bienvenida: se mantiene sincronizado con el primer paso.
    const first = graph.nodes.find((n) => n.id === graph.startNodeId);
    if (first) {
      await this.prisma.welcomeMessageConfig.upsert({
        where: { instanceId: instance.id },
        create: { instanceId: instance.id, enabled, message: first.text },
        update: { enabled, message: first.text },
      });
    }

    return { instanceName: instance.name, enabled: flow.enabled, graph, warnings };
  }

  // ---------- Motor ----------

  // true = habia un flujo activo y se inicio (el llamador no debe mandar el
  // mensaje de bienvenida legacy). false = no hay flujo para esta instancia.
  public async startFlow(instanceId: string, chatId: string, sender: BotSender): Promise<boolean> {
    const flow = await this.prisma.botFlow.findUnique({ where: { instanceId } });
    if (!flow) return false;
    if (!flow.enabled) return true; // hay flujo pero esta apagado: no manda nada, tampoco el legacy

    const { graph } = validateBotGraph(flow.graph);
    if (!graph?.startNodeId) return true;

    const session = await this.prisma.botSession
      .create({ data: { chatId, flowId: flow.id, status: 'active' } })
      .catch(() => null); // ya existe una sesion para este chat (unique): no se reinicia
    if (!session) return true;

    await this.run(session.id, graph, graph.startNodeId, chatId, sender);
    return true;
  }

  public async handleInbound(chatId: string, inbound: BotInbound, sender: BotSender): Promise<void> {
    const session = await this.prisma.botSession.findUnique({ where: { chatId }, include: { Flow: true } });
    if (!session || session.status !== 'active') return;

    // Texto libre (o cualquier otra cosa que no sea un boton del bot): el
    // bot se calla y sigue la asesora -- no se intenta adivinar la intencion.
    if (inbound.kind !== 'button' || !inbound.buttonId.startsWith(BUTTON_PREFIX)) {
      await this.prisma.botSession.updateMany({
        where: { id: session.id, status: 'active' },
        data: { status: 'handoff', currentNodeId: null },
      });
      return;
    }

    const [nodeId, optionId] = inbound.buttonId.slice(BUTTON_PREFIX.length).split(':');
    if (!nodeId || !optionId || nodeId !== session.currentNodeId) return; // boton de una pregunta vieja

    const { graph } = validateBotGraph(session.Flow.graph);
    const node = graph?.nodes.find((n) => n.id === nodeId);
    const option = node?.options?.find((o) => o.id === optionId);
    if (!graph || !node || !option) return;

    // Reclamo atomico: los webhooks de Meta se reintentan; solo el primero
    // que encuentra la sesion esperando esta pregunta avanza.
    const claim = await this.prisma.botSession.updateMany({
      where: { id: session.id, status: 'active', currentNodeId: nodeId },
      data: { currentNodeId: null },
    });
    if (claim.count === 0) return;

    const edge = graph.edges.find((e) => e.from === nodeId && e.fromOption === optionId);
    if (!edge) {
      await this.prisma.botSession.update({ where: { id: session.id }, data: { status: 'done' } });
      return;
    }
    await this.run(session.id, graph, edge.to, chatId, sender);
  }

  // Manda los pasos desde nodeId hasta toparse con una pregunta (queda
  // esperando el boton) o con el final del flujo.
  private async run(sessionId: string, graph: BotGraph, startId: string, chatId: string, sender: BotSender) {
    let nodeId: string | undefined = startId;
    try {
      for (let step = 0; step < MAX_STEPS && nodeId; step++) {
        const node = graph.nodes.find((n) => n.id === nodeId);
        if (!node) break;

        if (node.type === 'question') {
          await this.prisma.botSession.update({ where: { id: sessionId }, data: { currentNodeId: node.id } });
          await sender.sendButtons(
            node.text,
            (node.options ?? []).map((o) => ({ id: `${BUTTON_PREFIX}${node.id}:${o.id}`, title: o.title })),
          );
          return;
        }

        await sender.sendText(node.text);
        nodeId = graph.edges.find((e) => e.from === node.id)?.to;
      }
      await this.prisma.botSession.update({ where: { id: sessionId }, data: { status: 'done', currentNodeId: null } });
    } catch (error) {
      // Si falla un envio el bot no reintenta ni se queda a medias: pasa a
      // la asesora, que ve el chat igual.
      this.logger.error(`Bot: fallo enviando paso en chat ${chatId}: ${error}`);
      await this.prisma.botSession
        .update({ where: { id: sessionId }, data: { status: 'handoff', currentNodeId: null } })
        .catch(() => undefined);
    }
  }

  private async findInstance(instanceName: string) {
    if (!instanceName || typeof instanceName !== 'string') {
      throw new BadRequestException('instanceName is required');
    }
    const instance = await this.prisma.instance.findUnique({ where: { name: instanceName } });
    if (!instance) {
      throw new NotFoundException(`Instance "${instanceName}" not found`);
    }
    return instance;
  }
}
