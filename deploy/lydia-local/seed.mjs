// LYD-119: carga datos de prueba en el Lydia local.
//
//   node seed.mjs [--email alguien@brittanygroup.edu.pe ...]
//
// Crea (si no existen): la instancia de WhatsApp Cloud API falsa y tres
// conversaciones de ejemplo. Los agentes del staff ya los cargan las
// migraciones (20260917050000_agent_roles_real_staff); --email solo hace
// falta para alguien que no este ahi (sin agente activo con tu email el login
// de lydia_bg_front te rechaza). Se puede correr varias veces: lo que ya
// existe no se duplica, salvo los mensajes de ejemplo, que se vuelven a mandar.

import { api, INSTANCE_NAME, PHONE_NUMBER_ID, sendIncomingText, waitForApi } from './lib.mjs';

const emails = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--email' && process.argv[i + 1]) emails.push(process.argv[++i].toLowerCase());
}
const SAMPLE_CHATS = [
  { phone: '51911111111', name: 'Prospecto Prueba Uno', text: 'Hola, quiero informacion de los cursos de ingles' },
  { phone: '51922222222', name: 'Prospecto Prueba Dos', text: 'Buenas tardes, cuanto cuesta el ciclo basico?' },
  { phone: '51933333333', name: 'Prospecto Prueba Tres', text: 'Tienen horarios los sabados?' },
];

await waitForApi();

const instances = await api('/instance/fetchInstances');
if (instances.some((i) => i.name === INSTANCE_NAME)) {
  console.log(`Instancia "${INSTANCE_NAME}" ya existe`);
} else {
  // Token falso a proposito: cualquier envio saliente a Meta falla en local
  // en vez de llegarle a alguien.
  await api('/instance/create', {
    method: 'POST',
    body: {
      instanceName: INSTANCE_NAME,
      integration: 'WHATSAPP-BUSINESS',
      number: PHONE_NUMBER_ID,
      businessId: 'local-business',
      token: 'local-fake-meta-token',
    },
  });
  console.log(`Instancia "${INSTANCE_NAME}" creada (phone_number_id ${PHONE_NUMBER_ID})`);
}

const agents = await api('/crm/agents');
for (const email of emails) {
  if (agents.some((a) => a.email?.toLowerCase() === email)) {
    console.log(`Agente ${email} ya existe`);
    continue;
  }
  const name = email.split('@')[0].replace(/[._]/g, ' ');
  await api('/crm/agents', { method: 'POST', body: { name, email, role: 'administrador' } });
  console.log(`Agente ${email} creado (administrador)`);
}

for (const chat of SAMPLE_CHATS) {
  await sendIncomingText(chat);
  console.log(`Mensaje entrante de ${chat.name} (${chat.phone})`);
}

console.log('\nListo. Front: npm run dev en lydia_bg_front con el .env.local del README.');
