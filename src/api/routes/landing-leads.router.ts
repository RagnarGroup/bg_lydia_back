import 'express-async-errors';

import { landingLeadsController } from '@api/server.module';
import { ServiceUnavailableException, UnauthorizedException } from '@exceptions';
import { createHash, timingSafeEqual } from 'crypto';
import { Router } from 'express';

// LYD-83: cola CRM de leads de la landing. El back no conoce al usuario: el
// front manda agentId en el body (lo saca de su sesion).
export class LandingLeadsRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router
      .get('/', async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        return res.json(
          await landingLeadsController.list({
            sede: q.sede,
            visitStatus: q.visitStatus,
            from: q.from,
            to: q.to,
            unclaimed: q.unclaimed,
            search: q.search,
            programa: q.programa,
            tag: q.tag,
          }),
        );
      })
      // Antes de /:id, o "summary" se tomaria como un id.
      .get('/summary', async (_req, res) => res.json(await landingLeadsController.summary()))
      .get('/:id', async (req, res) => res.json(await landingLeadsController.getDetail(req.params.id)))
      .post('/:id/claim', async (req, res) =>
        res.json(await landingLeadsController.claim(req.params.id, req.body?.agentId)),
      )
      .post('/:id/release', async (req, res) =>
        res.json(await landingLeadsController.release(req.params.id, req.body?.agentId)),
      )
      .post('/:id/visit', async (req, res) =>
        res.json(await landingLeadsController.updateVisit(req.params.id, req.body ?? {})),
      )
      .post('/:id/notes', async (req, res) =>
        res.status(201).json(await landingLeadsController.addNote(req.params.id, req.body ?? {})),
      )
      .post('/:id/stage', async (req, res) =>
        res.json(await landingLeadsController.changeStage(req.params.id, req.body ?? {})),
      );
  }
}

// POST /public/landing-leads -- sin apikey de Evolution: auth propia por
// x-landing-token (el WordPress de la landing reenvia server-side).
export class LandingLeadsPublicRouter {
  public readonly router: Router = Router();

  constructor() {
    this.router.post('/', async (req, res) => {
      const expected = process.env.LANDING_WEBHOOK_TOKEN;
      // Sin token configurado el endpoint no acepta nada.
      if (!expected) throw new ServiceUnavailableException('Landing webhook not configured');

      const provided = req.get('x-landing-token');
      // Hash de ambos: timingSafeEqual exige igual largo y asi no se filtra el del token.
      const a = createHash('sha256')
        .update(provided ?? '')
        .digest();
      const b = createHash('sha256').update(expected).digest();
      if (!provided || !timingSafeEqual(a, b)) throw new UnauthorizedException('Invalid landing token');

      const result = await landingLeadsController.createFromLanding(req.body);
      if (!result.created) {
        return res.status(200).json({ id: result.id, leadNumber: result.leadNumber, duplicated: true });
      }
      return res.status(201).json({ id: result.id, leadNumber: result.leadNumber });
    });
  }
}
