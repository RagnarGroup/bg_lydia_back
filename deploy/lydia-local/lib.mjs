// LYD-119: utilidades compartidas por seed.mjs y simulate-message.mjs.
// Sin dependencias: solo Node 18+ (fetch y crypto nativos).

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Lee deploy/lydia-local/.env (el mismo que usa docker compose).
function loadEnv() {
  let text;
  try {
    text = readFileSync(join(here, '.env'), 'utf8');
  } catch {
    throw new Error('Falta deploy/lydia-local/.env: copiar .env.example a .env');
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

export const env = loadEnv();
export const API_URL = process.env.LYDIA_API_URL ?? 'http://localhost:8091';

// Instancia de WhatsApp Cloud API falsa: el phone_number_id es lo que el
// webhook de Meta usa para encontrar la instancia (meta.controller.ts).
export const INSTANCE_NAME = 'Lydia Local';
export const PHONE_NUMBER_ID = '100000000000001';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { apikey: env.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> HTTP ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
    );
  }
  return data;
}

export async function waitForApi(timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${API_URL}/`);
      if (res.ok) return;
    } catch {
      // todavia levantando
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Evolution API no respondio en ${API_URL} (docker compose logs evolution-api)`);
}

// Envia a /webhook/meta un mensaje de texto entrante con la misma forma y la
// misma firma (X-Hub-Signature-256) que manda Meta.
// LYD-118: secondsAgo fecha el mensaje en el pasado (probar las alertas de 5 y
// 10 min sin respuesta sin esperar).
export async function sendIncomingText({ phone, name, text, secondsAgo = 0 }) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'local-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '51900000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name }, wa_id: phone }],
              messages: [
                {
                  from: phone,
                  id: `wamid.local-${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000) - secondsAgo),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', env.WA_BUSINESS_APP_SECRET).update(raw).digest('hex');
  const res = await fetch(`${API_URL}/webhook/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${signature}` },
    body: raw,
  });
  if (!res.ok) throw new Error(`POST /webhook/meta -> HTTP ${res.status}: ${await res.text()}`);
}
