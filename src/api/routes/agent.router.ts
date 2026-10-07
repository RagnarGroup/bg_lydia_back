import 'express-async-errors';

import { agentController } from '@api/server.module';
import { Router } from 'express';

// LYD-69: registrada como /crm/agent (ver index.router.ts).
export class AgentRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router
      .get('/knowledge', async (req, res) => res.json(await agentController.listKnowledge()))
      .post('/knowledge', async (req, res) =>
        res.status(201).json(await agentController.createKnowledge(req.body ?? {})),
      )
      .patch('/knowledge/:id', async (req, res) =>
        res.json(await agentController.updateKnowledge(req.params.id, req.body ?? {})),
      )
      .delete('/knowledge/:id', async (req, res) => {
        await agentController.deleteKnowledge(req.params.id);
        return res.status(204).send();
      })
      .get('/instructions', async (req, res) => res.json(await agentController.getInstructions()))
      .put('/instructions', async (req, res) => res.json(await agentController.setInstructions(req.body ?? {})))
      // Prueba de la pantalla "Agente": sugerencia para un mensaje escrito a
      // mano, sin conversacion real. No envia nada a nadie.
      .post('/test', async (req, res) => res.json(await agentController.testSuggestion(req.body?.message)));
  }
}
