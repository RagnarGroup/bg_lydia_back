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
      // LYD-101: sedes de las asesoras copiadas del SGA, cruzadas por email.
      .put('/agents/sedes', async (req, res) => {
        return res.json(await crmController.syncAgentSedes(req.body?.agents));
      })
      // LYD-101: autoria de un mensaje enviado desde el inbox (agentId de la
      // sesion + key.id devuelto por el envio).
      .post('/message-authors', async (req, res) => {
        const { instanceName, messageKeyId, agentId } = req.body ?? {};
        return res.status(201).json(await crmController.recordMessageAuthor({ instanceName, messageKeyId, agentId }));
      })
      // LYD-105: "Ver detalles" de un mensaje (quien lo envio y estado de entrega).
      .get('/messages/:messageId/details', async (req, res) => {
        return res.json(await crmController.getMessageDetails(req.params.messageId));
      })
      .get('/conversations', async (req, res) => {
        // LYD-31: instanceName es opcional -- sin el, se listan todos los canales juntos.
        // LYD-79: limit/cursor paginan (respuesta { conversations, nextCursor });
        // sin limit, array completo como antes. channel y q filtran en la base.
        const { instanceName, status, assignedAgentId, channel, q, source, campaign, limit, cursor } = req.query as {
          instanceName?: string;
          status?: ChatStatus;
          assignedAgentId?: string;
          channel?: string;
          q?: string;
          source?: string;
          campaign?: string;
          limit?: string;
          cursor?: string;
        };
        return res.json(
          await crmController.listConversations({
            instanceName,
            status,
            assignedAgentId,
            channel,
            q,
            source,
            campaign,
            limit,
            cursor,
          }),
        );
      })
      // LYD-96: campanas/anuncios para el filtro del inbox (antes de /conversations/:chatId por claridad).
      .get('/campaigns', async (req, res) => {
        return res.json(await crmController.listCampaigns());
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
        const {
          status,
          assignedAgentId,
          unreadMessages,
          contactNameOverride,
          contactPhoneOverride,
          archived,
          agentTags,
        } = req.body ?? {};
        return res.json(
          await crmController.updateConversation(req.params.chatId, {
            status,
            assignedAgentId,
            unreadMessages,
            contactNameOverride,
            contactPhoneOverride,
            archived,
            agentTags,
          }),
        );
      })
      // LYD-77: autoasignacion al responder -- solo toma el chat si no tiene
      // responsable; nunca le cambia el dueño a uno ya asignado.
      .post('/conversations/:chatId/claim', async (req, res) => {
        return res.json(await crmController.claimConversation(req.params.chatId, req.body ?? {}));
      })
      .delete('/conversations/:chatId', async (req, res) => {
        await crmController.deleteConversation(req.params.chatId);
        return res.status(204).send();
      })
      // LYD-68: pide a la IA una respuesta sugerida; no envia nada al cliente.
      .post('/conversations/:chatId/suggest-reply', async (req, res) => {
        return res.json(await crmController.suggestReply(req.params.chatId));
      })
      // LYD-74: chat con el agente IA (mensaje + respuesta sugerida + etiquetas).
      .post('/conversations/:chatId/agent-chat', async (req, res) => {
        return res.json(await crmController.agentChat(req.params.chatId, { messages: req.body?.messages }));
      })
      // LYD-117: porcentaje de participacion de cada asesora (ultima auditoria diaria).
      .get('/conversations/:chatId/participants', async (req, res) => {
        return res.json(await crmController.getChatParticipants(req.params.chatId));
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
