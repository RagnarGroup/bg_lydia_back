import 'express-async-errors';

import { leadsController } from '@api/server.module';
import { LeadStage, LeadType } from '@prisma/client';
import { Router } from 'express';

// LYD-8: CRUD simple sobre el pipeline de leads propio de Lydia. Mismo
// criterio que CrmRouter -- no extiende RouterBroker (pensado para rutas
// ancladas a /:instanceName de WhatsApp), estas rutas son globales.
export class LeadsRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router
      .get('/', async (req, res) => {
        const { stage, leadType, assignedAgentId, source, chatId } = req.query as {
          stage?: LeadStage;
          leadType?: LeadType;
          assignedAgentId?: string;
          source?: string;
          chatId?: string;
        };
        return res.json(await leadsController.listLeads({ stage, leadType, assignedAgentId, source, chatId }));
      })
      .post('/', async (req, res) => {
        return res.status(201).json(await leadsController.createLead(req.body ?? {}));
      })
      .get('/:id', async (req, res) => {
        return res.json(await leadsController.getLead(req.params.id));
      })
      .patch('/:id', async (req, res) => {
        return res.json(await leadsController.updateLead(req.params.id, req.body ?? {}));
      })
      .delete('/:id', async (req, res) => {
        await leadsController.deleteLead(req.params.id);
        return res.status(204).send();
      });
  }
}
