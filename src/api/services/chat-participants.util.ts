// LYD-117: asesoras que participaron en una conversacion (las que enviaron al
// menos un mensaje desde el inbox, segun MessageAuthor). Helper puro, separado
// de MessageAuthorService para testearlo sin Prisma.

export interface ParticipantRow {
  chatId: string;
  agentId: string;
  messages: number;
  firstAt: number;
  lastAt: number;
}

export interface ParticipantAgent {
  id: string;
  name: string;
  email: string | null;
  color: string | null;
}

export interface ChatParticipant {
  agent: ParticipantAgent;
  messages: number;
  firstMessageAt: string;
  lastMessageAt: string;
}

// Orden: quien escribio primero va primero. Filas de una asesora que ya no
// existe se descartan (MessageAuthor.agentId queda en null al borrarla, pero
// por las dudas no se inventa un nombre).
export function groupParticipants(rows: ParticipantRow[], agents: ParticipantAgent[]): Map<string, ChatParticipant[]> {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const byChat = new Map<string, ChatParticipant[]>();

  for (const row of rows) {
    const agent = agentsById.get(row.agentId);
    if (!agent) continue;
    const list = byChat.get(row.chatId) ?? [];
    list.push({
      agent,
      messages: row.messages,
      firstMessageAt: new Date(row.firstAt * 1000).toISOString(),
      lastMessageAt: new Date(row.lastAt * 1000).toISOString(),
    });
    byChat.set(row.chatId, list);
  }

  for (const list of byChat.values()) {
    list.sort((a, b) => a.firstMessageAt.localeCompare(b.firstMessageAt) || a.agent.name.localeCompare(b.agent.name));
  }
  return byChat;
}
