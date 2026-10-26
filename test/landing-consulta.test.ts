// LYD-100: npx tsx --test --test-force-exit test/landing-consulta.test.ts
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// server.module primero, como en la app: @exceptions importa HttpStatus del
// router principal y ese importa los servicios (ciclo que el punto de entrada
// resuelve cargando server.module antes que nada). Sin esto el import del
// servicio falla con "Cannot access 'LandingLeadsService' before initialization".
// No abre conexiones: PrismaClient conecta recién en la primera consulta, y el
// test le pasa al servicio una base falsa.
import '../src/api/server.module';
// eslint-disable-next-line import/order
import { LandingLeadsService } from '../src/api/services/landing-leads.service';

type Row = Record<string, any>;

// Prisma en memoria: solo las consultas que usa el alta de landing.
function fakePrisma() {
  const leads: Row[] = [];
  const activities: Row[] = [];
  let seq = 0;
  const pick = (row: Row | undefined, select?: Row) => {
    if (!row) return null;
    if (!select) return row;
    const out: Row = {};
    for (const k of Object.keys(select)) out[k] = row[k];
    return out;
  };
  const db: Row = {
    leads,
    activities,
    lead: {
      findUnique: async ({ where, select }: Row) =>
        pick(
          leads.find((l) => l.externalId && l.externalId === where.externalId),
          select,
        ),
      findFirst: async ({ where, select }: Row) => {
        const match = leads
          .filter(
            (l) =>
              l.source === where.source &&
              l.programa === where.programa &&
              typeof l.email === 'string' &&
              l.email.toLowerCase() === String(where.email.equals).toLowerCase(),
          )
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        return pick(match, select);
      },
      findMany: async () => leads.map((l) => ({ leadNumber: l.leadNumber })),
      create: async ({ data, select }: Row) => {
        if (data.externalId && leads.some((l) => l.externalId === data.externalId)) throw new Error('P2002');
        const row = { id: `lead-${++seq}`, createdAt: seq, ...data };
        leads.push(row);
        return pick(row, select);
      },
      update: async ({ where, data }: Row) => {
        const row = leads.find((l) => l.id === where.id);
        Object.assign(row!, data);
        return row;
      },
    },
    leadActivity: {
      create: async ({ data }: Row) => {
        const row = { id: `act-${++seq}`, ...data };
        activities.push(row);
        return row;
      },
      findFirst: async ({ where }: Row) => {
        const a = activities.find(
          (x) => x.type === where.type && x.meta?.[where.meta.path[0]] === where.meta.equals,
        );
        return a ? { Lead: pick(leads.find((l) => l.id === a.leadId), { id: 1, leadNumber: 1 }) } : null;
      },
    },
  };
  db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(db);
  return db;
}

// Las excepciones del proyecto son objetos { status, message: string[] }, no Error.
const rejectsWith = (promise: Promise<unknown>, pattern: RegExp) =>
  assert.rejects(promise, (err: any) => {
    const text = Array.isArray(err?.message) ? err.message.join(' ') : String(err?.message ?? err);
    assert.equal(err?.status, 400, `se esperaba 400 y llegó ${err?.status}: ${text}`);
    assert.match(text, pattern);
    return true;
  });

const consulta = (overrides: Row = {}) => ({
  tipo: 'consulta' as const,
  programa: 'Spanish Immersion',
  nombre: 'Emma Watson',
  correo: 'Emma@Example.com',
  tags: ['SPANISH_IMMERSION', 'IMMERSION_AREQUIPA'],
  attribution: { utm_source: 'instagram', landing_url: 'https://immersion.brittanygroup.edu.pe/arequipa/' },
  detalle: {
    opcion: 'Arequipa · 4 weeks',
    precio: '£1,195',
    mesInicio: 'March 2027',
    pais: 'United Kingdom',
    nivel: 'Beginner',
  },
  ...overrides,
});

describe('LandingLeadsService · consultas sin visita (LYD-100)', () => {
  let db: Row;
  let service: LandingLeadsService;

  beforeEach(() => {
    db = fakePrisma();
    service = new LandingLeadsService(db as any);
  });

  it('acepta TEFL England (LYD-107) con WhatsApp y el nivel como nivel de inglés', async () => {
    const r = await service.createFromLanding(
      consulta({
        programa: 'TEFL England',
        correo: 'maria@example.com',
        whatsapp: '987654321',
        tags: ['TEFL_ENGLAND'],
        attribution: { utm_source: 'facebook' },
        detalle: { opcion: 'Prácticas: Arequipa', precio: 'S/ 2,600', nivel: 'C1' },
        externalId: 'tefl-england:sub-1',
      }),
    );
    assert.equal(r.created, true);
    const lead = db.leads[0];
    assert.equal(lead.programa, 'TEFL England');
    assert.equal(lead.phone, '987654321');
    assert.deepEqual(lead.tags, ['TEFL_ENGLAND']);
    assert.equal(lead.observations, 'Opción: Prácticas: Arequipa · Precio: S/ 2,600 · Nivel de inglés: C1');
  });

  it('un mismo correo en Spanish Immersion y en TEFL England son dos leads distintos', async () => {
    await service.createFromLanding(consulta({ correo: 'ana@example.com' }));
    const r = await service.createFromLanding(
      consulta({ programa: 'TEFL England', correo: 'ana@example.com', tags: ['TEFL_ENGLAND'] }),
    );
    assert.equal(r.created, true);
    assert.equal(db.leads.length, 2);
  });

  it('crea el lead sin sede ni visita, con el correo en minúsculas y el detalle legible', async () => {
    const r = await service.createFromLanding(consulta({ externalId: 'sub-1' }));
    assert.equal(r.created, true);
    assert.equal(db.leads.length, 1);
    const lead = db.leads[0];
    assert.equal(lead.email, 'emma@example.com');
    assert.equal(lead.sede, null);
    assert.equal(lead.visitAt, null);
    assert.equal(lead.visitStatus, null);
    assert.equal(lead.phone, null);
    assert.equal(lead.source, 'landing');
    assert.equal(lead.leadNumber, 'LD-1');
    assert.deepEqual(lead.tags, ['SPANISH_IMMERSION', 'IMMERSION_AREQUIPA']);
    assert.equal(
      lead.observations,
      'Opción: Arequipa · 4 weeks · Precio: £1,195 · Mes de inicio: March 2027 · País: United Kingdom · Nivel de español: Beginner',
    );
    assert.deepEqual(lead.attribution, {
      utm_source: 'instagram',
      landing_url: 'https://immersion.brittanygroup.edu.pe/arequipa/',
    });
    assert.equal(db.activities.length, 1);
    assert.equal(db.activities[0].type, 'creado');
    assert.equal(db.activities[0].meta.tipo, 'consulta');
  });

  it('el mismo email (aunque cambie de mayúsculas) no crea otro lead: suma la consulta al historial', async () => {
    const first = await service.createFromLanding(consulta({ externalId: 'sub-1' }));
    const second = await service.createFromLanding(
      consulta({
        externalId: 'sub-2',
        correo: 'EMMA@example.COM',
        tags: ['SPANISH_IMMERSION', 'IMMERSION_LIMA'],
        attribution: { utm_source: 'tiktok' },
        detalle: { opcion: 'Lima · 4 weeks', precio: '£1,495', mesInicio: 'May 2027' },
      }),
    );
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.equal(db.leads.length, 1);
    const lead = db.leads[0];
    assert.deepEqual(lead.tags, ['SPANISH_IMMERSION', 'IMMERSION_AREQUIPA', 'IMMERSION_LIMA']);
    assert.equal(lead.observations, 'Opción: Lima · 4 weeks · Precio: £1,495 · Mes de inicio: May 2027');
    // First-touch: la atribución del lead no se pisa; la nueva queda en el historial.
    assert.equal(lead.attribution.utm_source, 'instagram');
    const consultaAct = db.activities.find((a: Row) => a.type === 'consulta');
    assert.equal(consultaAct.meta.attribution.utm_source, 'tiktok');
    assert.equal(consultaAct.meta.detalle.opcion, 'Lima · 4 weeks');
  });

  it('los reintentos de un mismo envío no duplican ni el lead ni la consulta', async () => {
    await service.createFromLanding(consulta({ externalId: 'sub-1' }));
    await service.createFromLanding(consulta({ externalId: 'sub-1' }));
    await service.createFromLanding(consulta({ externalId: 'sub-2' }));
    await service.createFromLanding(consulta({ externalId: 'sub-2' }));
    assert.equal(db.leads.length, 1);
    assert.equal(db.activities.filter((a: Row) => a.type === 'consulta').length, 1);
  });

  it('valida los datos de la consulta', async () => {
    await rejectsWith(service.createFromLanding(consulta({ correo: '' })), /correo is required/);
    await rejectsWith(service.createFromLanding(consulta({ correo: 'no-es-email' })), /not a valid email/);
    await rejectsWith(service.createFromLanding(consulta({ programa: 'Adultos' })), /programa must be one of/);
    await rejectsWith(service.createFromLanding(consulta({ nombre: '  ' })), /nombre is required/);
    await rejectsWith(service.createFromLanding(consulta({ detalle: { pais: 'x'.repeat(81) } })),
      /detalle\.pais must be at most 80/,
    );
    await rejectsWith(service.createFromLanding(consulta({ tags: ['minusculas'] })), /each tag must match/);
    assert.equal(db.leads.length, 0);
  });

  it('sin tipo "consulta" se mantiene el flujo de visitas: exige sede, fecha y hora', async () => {
    await rejectsWith(service.createFromLanding({
        programa: 'Adultos',
        nombre: 'Ana',
        whatsapp: '999999999',
        correo: 'ana@example.com',
      } as any),
      /sede is required/,
    );
  });
});
