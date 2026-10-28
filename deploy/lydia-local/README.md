# Lydia — entorno de desarrollo local

LYD-119. Lydia completa en la PC para probar cambios sin tocar producción,
pensado sobre todo para notificaciones (mensajes entrantes a pedido).

| Pieza | Dónde |
| --- | --- |
| Evolution API (este repo) | `http://localhost:8091`, contenedor `lydia_local_evolution_api` |
| Postgres | `localhost:5433` (usuario `postgres`, base `evolution`) |
| Redis, audio-converter | solo dentro de la red `lydia_local_net` |
| Frontend (`lydia_bg_front`) | `npm run dev` en la PC → `http://localhost:3000` |

Diferencias con producción:

- **Base vacía.** Nunca restaurar un dump de prod: la instancia de prod guarda
  el token de Meta (el bot o una respuesta de prueba le escribirían a clientes
  reales) y la base tiene datos personales.
- **Sin canales reales.** Meta admite una sola URL de webhook por app y apunta
  a prod. Los mensajes entrantes se simulan con `simulate-message.mjs`, que
  firma el webhook con el `WA_BUSINESS_APP_SECRET` local. Los envíos salientes
  fallan a propósito: la instancia local tiene un token falso.
- **Apagados:** auditoría comercial, SMTP, TikTok y codex bridge (la
  sugerencia con IA no responde en local).

## Primera vez

Requisitos: Docker Desktop corriendo y Node 18+.

```bash
cd lydia_bg_back/deploy/lydia-local
cp .env.example .env
docker compose up -d --build        # el primer build tarda varios minutos
node seed.mjs
```

El seed crea la instancia `Lydia Local` (WhatsApp Cloud API falsa) y tres
conversaciones de ejemplo. Los agentes del staff ya vienen cargados por las
migraciones, así que el login funciona con tu cuenta de siempre. Si alguien no
está en esa lista, agregarlo con `node seed.mjs --email alguien@brittanygroup.edu.pe`
(sin agente activo con tu email, el login del front te rechaza).

Después, en `lydia_bg_front`, crear `.env.local` a partir de `.env.example` con:

```bash
NEXT_PUBLIC_LYDIA_API_ENABLED=true
EVOLUTION_API_URL=http://localhost:8091
EVOLUTION_API_KEY=lydia-local-apikey      # EVOLUTION_API_KEY de deploy/lydia-local/.env
SESSION_SECRET=<cualquier cadena larga>   # openssl rand -base64 48
# NEXT_PUBLIC_FIREBASE_*: los de .env.example tal cual
```

y correr `npm run dev`. El login con Google funciona en `localhost` sin tocar
Firebase (viene autorizado por defecto).

## Simular mensajes entrantes

```bash
node simulate-message.mjs                                   # 1 mensaje, contacto de prueba
node simulate-message.mjs --text "Hola" --phone 51955555555 --name "Ana Prueba"
node simulate-message.mjs --count 5 --every 10              # 5 mensajes, uno cada 10 s
node simulate-message.mjs --minutes-ago 11                  # fechado hace 11 min: alerta roja sin esperar
```

Cada `--phone` distinto es una conversación distinta. Para que suene la alerta
del navegador, el inbox tiene que estar abierto en otra conversación (o en
ninguna).

## Día a día

```bash
docker compose up -d --build evolution-api   # tras cambiar código del back
docker compose logs -f evolution-api
docker compose down                          # apagar (los datos quedan)
docker compose down -v                       # borrar todo y empezar de cero (volver a correr seed.mjs)
```

Las migraciones de Prisma se aplican solas al arrancar el contenedor, igual
que en prod.
