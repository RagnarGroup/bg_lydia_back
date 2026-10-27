// LYD-117: participacion de las asesoras en una conversacion, tal como la dejo
// la auditoria diaria (ConversationParticipation). Helper puro, separado del
// service para testearlo sin Prisma.

export interface ParticipationRow {
  chatId: string;
  percent: number;
  reason: string | null;
  Run: { reportDate: string };
  Agent: { id: string; name: string; email: string | null; color: string | null };
}

export interface ChatParticipant {
  agent: ParticipationRow['Agent'];
  percent: number;
  reason: string | null;
  reportDate: string;
}

// Por chat se queda con la corrida mas reciente (cada dia recalcula sobre el
// historial de la conversacion) y ordena de mayor a menor participacion.
export function latestParticipation(rows: ParticipationRow[]): Map<string, ChatParticipant[]> {
  const latestDate = new Map<string, string>();
  for (const row of rows) {
    const current = latestDate.get(row.chatId);
    if (!current || row.Run.reportDate > current) latestDate.set(row.chatId, row.Run.reportDate);
  }

  const byChat = new Map<string, ChatParticipant[]>();
  for (const row of rows) {
    if (row.Run.reportDate !== latestDate.get(row.chatId)) continue;
    const list = byChat.get(row.chatId) ?? [];
    list.push({ agent: row.Agent, percent: row.percent, reason: row.reason, reportDate: row.Run.reportDate });
    byChat.set(row.chatId, list);
  }
  for (const list of byChat.values()) {
    list.sort((a, b) => b.percent - a.percent || a.agent.name.localeCompare(b.agent.name));
  }
  return byChat;
}
