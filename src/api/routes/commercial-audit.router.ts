import 'express-async-errors';

import { commercialAuditController } from '@api/server.module';
import { Router } from 'express';

// LYD-102: corridas de la auditoria comercial diaria. La programacion diaria
// (20:00 evalua, 21:00 envia) no pasa por aca; estas rutas son para el piloto
// y para reprocesar o reenviar un dia puntual.
export class CommercialAuditRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router
      // Evalua en segundo plano el dia indicado (por defecto hoy, hora de Lima). No envia.
      .post('/runs', async (req, res) => {
        return res.status(202).json(commercialAuditController.startRun(req.body?.date));
      })
      .get('/runs/:date', async (req, res) => {
        return res.json(await commercialAuditController.getRun(req.params.date));
      })
      .get('/runs/:date/html', async (req, res) => {
        return res.type('html').send(await commercialAuditController.getRunHtml(req.params.date));
      })
      // `to` opcional: manda solo a esas direcciones (piloto) sin marcar la corrida como enviada.
      .post('/runs/:date/send', async (req, res) => {
        return res.json(await commercialAuditController.sendRun(req.params.date, req.body?.to));
      });
  }
}
