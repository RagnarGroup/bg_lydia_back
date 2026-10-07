import 'express-async-errors';

import { crmController } from '@api/server.module';
import { AgentRole, ChatStatus } from '@prisma/client';
import { Router } from 'express';

// CRM-12: capa de agentes/asignacion/notas para el frontend de Lydia
// (lydia_bg_front), reemplazando lo que daba Chatwoot. No extiende
// RouterBroker: ese abstraccion asume rutas ancladas a /:instanceName con
// validacion JSONSchema pensada para operaciones de WhatsApp -- estas rutas
// son CRUD simple sobre datos propios de Lydia, sin esa forma.
export class CrmRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router
      .get('/agents', async (req, res) => {
        return res.json(await crmController.listAgents());
      })
      .post('/agents', async (req, res) => {
        const { name, email, color, role } = req.body ?? {};
        return res.status(201).json(await crmController.createAgent({ name, email, color, role: role as AgentRole }));
      })
      .get('/conversations', async (req, res) => {
        // LYD-31: instanceName es opcional -- sin el, se listan todos los canales juntos.
        const { instanceName, status, assignedAgentId } = req.query as {
          instanceName?: string;
          status?: ChatStatus;
          assignedAgentId?: string;
        };
        return res.json(await crmController.listConversations({ instanceName, status, assignedAgentId }));
      })
      // LYD-60: tiene que ir antes de /conversations/:chatId, si no Express
      // toma "search" como un chatId.
      .get('/conversations/search', async (req, res) => {
        const { q, instanceName, limit } = req.query as { q?: string; instanceName?: string; limit?: string };
        return res.json(await crmController.searchMessages({ q, instanceName, limit }));
      })
      .get('/conversations/:chatId', async (req, res) => {
        return res.json(await crmController.getConversation(req.params.chatId));
      })
      .patch('/conversations/:chatId', async (req, res) => {
        const { status, assignedAgentId, unreadMessages, contactNameOverride, contactPhoneOverride, archived } =
          req.body ?? {};
        return res.json(
          await crmController.updateConversation(req.params.chatId, {
            status,
            assignedAgentId,
            unreadMessages,
            contactNameOverride,
            contactPhoneOverride,
            archived,
          }),
        );
      })
      .delete('/conversations/:chatId', async (req, res) => {
        await crmController.deleteConversation(req.params.chatId);
        return res.status(204).send();
      })
      // LYD-68: pide a la IA una respuesta sugerida; no envia nada al cliente.
      .post('/conversations/:chatId/suggest-reply', async (req, res) => {
        return res.json(await crmController.suggestReply(req.params.chatId));
      })
      .get('/conversations/:chatId/notes', async (req, res) => {
        return res.json(await crmController.listNotes(req.params.chatId));
      })
      .post('/conversations/:chatId/notes', async (req, res) => {
        const { content, agentId } = req.body ?? {};
        return res.status(201).json(await crmController.addNote(req.params.chatId, { content, agentId }));
      });
  }
}
