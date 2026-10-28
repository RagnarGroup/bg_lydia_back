// LYD-119: simula mensajes entrantes de WhatsApp en el Lydia local, para
// probar notificaciones (sonido, aviso del navegador, contador de no leidos,
// alertas por tiempo sin respuesta).
//
//   node simulate-message.mjs                         # 1 mensaje de un contacto de prueba
//   node simulate-message.mjs --text "Hola" --phone 51944444444 --name "Ana Prueba"
//   node simulate-message.mjs --count 5 --every 10    # 5 mensajes, uno cada 10 s
//   node simulate-message.mjs --minutes-ago 6         # fechado hace 6 min (alerta amarilla de LYD-118)
//
// Cada telefono distinto es una conversacion distinta; repetir el mismo
// --phone agrega mensajes a la misma conversacion.

import { sendIncomingText } from './lib.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  args[key] = process.argv[i + 1];
}

const phone = args.phone ?? '51944444444';
const name = args.name ?? 'Contacto Simulado';
const count = Number(args.count ?? 1);
const everySeconds = Number(args.every ?? 0);
const secondsAgo = Math.round(Number(args['minutes-ago'] ?? 0) * 60);

for (let n = 1; n <= count; n++) {
  const text = args.text ?? `Mensaje de prueba ${n} (${new Date().toLocaleTimeString('es-PE')})`;
  await sendIncomingText({ phone, name, text, secondsAgo });
  console.log(`[${n}/${count}] ${name} (${phone}): ${text}`);
  if (n < count && everySeconds > 0) await new Promise((r) => setTimeout(r, everySeconds * 1000));
}
