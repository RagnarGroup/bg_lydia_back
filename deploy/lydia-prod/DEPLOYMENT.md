# Despliegue — Lydia producción (VPS Brittany)

CRM-10/CRM-11. Infraestructura en el VPS Contabo de Brittany Group
(`144.126.142.27`, acceso `ssh brittany`). Primer servicio del VPS de
Brittany que corre sobre Docker (ver INF-105: el resto sigue siendo
binarios + systemd).

Esta carpeta vivía antes en `CRM_brittanygroup/deploy/lydia-prod/`; ese repo
se eliminó por completo (CRM-11) y esto se movió a `lydia_bg_back`, que es
el repo "ancla" de la stack (Postgres/Redis/Evolution API).

## Entorno

Solo existe producción en el VPS. No hay `development` desplegado para
Lydia — los workflows de `lydia_bg_back` y `lydia_bg_front` rechazan
cualquier rama que no sea `main` en vez de caer a un entorno de desarrollo
(no hay ninguno al que caer). Para probar cambios, el entorno local de
`deploy/lydia-local/` (ver su README.md) levanta el mismo stack en la PC,
con base vacía y mensajes entrantes simulados.

|                    | producción |
| ------------------ | --- |
| Directorio         | `/lydia_prod/` (`back/`, `front/`, `docker-compose.yml`, `.env`) |
| Frontend (Next.js) | `127.0.0.1:3009` → `crm.brittanygroup.edu.pe` |
| Evolution API      | `127.0.0.1:8091` → `api-crm.brittanygroup.edu.pe` (no 8090: lo ocupa la LAPI de CrowdSec) |
| Postgres / Redis   | contenedores propios (`lydia_postgres`, `lydia_redis`), red `lydia_internal_net` — no el MySQL/Redis nativos del host |
| Audio converter    | `lydia_audio_converter`, solo interno a `lydia_internal_net` (sin puerto publicado) |
| Usuario deploy     | `deploy_lydia` |
| Wrappers de reload | `/usr/local/sbin/deploy-reload-lydia-back`, `/usr/local/sbin/deploy-reload-lydia-front` |

## CRM-11: Chatwoot salió del stack

`chatwoot_web`/`chatwoot_worker` (Rails, build de 20+ min por la gema `grpc`
de Dialogflow) se reemplazaron por `frontend`, buildeado desde `./front`
(ahora el Next.js propio de Lydia, ver `lydia_bg_front/CLAUDE.md`). La
integración `CHATWOOT_ENABLED` de Evolution API quedó apagada — ya no hay
Chatwoot al otro lado. El frontend arranca con
`NEXT_PUBLIC_CHATWOOT_ENABLED=false` (datos de ejemplo) hasta que CRM-12
construya endpoints reales de conversaciones/asignación/notas en
`lydia_bg_back` y se apunte ahí.

`evolution-api` sigue siendo build propio (`./back`, fork `lydia_bg_back`)
en vez de pullear `evoapicloud/evolution-api:latest` de Docker Hub.

## Notas de voz (audio-converter)

Las notas de voz grabadas en el navegador (`lydia_bg_front`) llegan como
webm/opus o mp4/aac según el browser. `evolution-api` ya sabe pasar el audio
por un conversor externo antes de subirlo a WhatsApp (`API_AUDIO_CONVERTER`,
nativo del fork, sin tocar código), y ese conversor es el servicio
`audio-converter` de este mismo `docker-compose.yml` (build desde
`./audio-converter`, Express + ffmpeg, sin puerto publicado — solo
`evolution-api` le habla adentro de `lydia_internal_net`). Se autentica con
`API_AUDIO_CONVERTER_KEY` (header `apikey`), generada por
`generate_secrets.sh` igual que el resto de los secretos de este `.env`.

## Auditoría comercial diaria (META K-01)

`evolution-api` evalúa todos los días las conversaciones comerciales de las
asesoras y manda el reporte por correo (LYD-101 autoría por mensaje, LYD-102
auditoría). Horario en America/Lima, programado dentro del propio proceso
(`node-cron`):

- **21:00**: corte y evaluación de la ventana 21:00 de ayer → 21:00 de hoy, por
  el codex bridge, con los datos del cliente anonimizados.
- **22:00**: correo a `COMMERCIAL_AUDIT_TO`. Si la evaluación termina más
  tarde, sale apenas termina.
- **23:30**: si no salió, alerta a `COMMERCIAL_AUDIT_ALERT_TO`.

Se activa con `COMMERCIAL_AUDIT_ENABLED=true` en `/lydia_prod/.env`. El correo
sale con la misma cuenta que usa el SGA: `soporte@brittanygroup.edu.pe` por
`mail.brittanygroup.edu.pe:465` (buzón de Banahost; el MX del dominio está en
Google, pero el envío va por Banahost). `SMTP_PASS` es el `MAIL_PASS` del `.env`
del SGA, copiado dentro del VPS. Como `docker-compose.yml` vive en
`/lydia_prod/` y el workflow solo sincroniza `back/`, las variables nuevas del
compose se copian a mano desde `back/deploy/lydia-prod/docker-compose.yml`.

Si `evolution-api` se reinicia después del corte (por un deploy, por ejemplo) y
el reporte del día no salió, al arrancar vuelve a correr la evaluación y la
envía apenas termina si ya pasaron las 22:00.

Las sedes de cada agente vienen del SGA (`users` → `user_sedes`, cualquier rol,
cruce por email). Se sincronizan con `sync-sedes-sga.sh` (en esta carpeta; en el
VPS: `sudo /lydia_prod/back/deploy/lydia-prod/sync-sedes-sga.sh`), que solo
lee el SGA y actualiza `Agent.sedes` en Lydia. Correrlo cuando cambien las
sedes del personal en el SGA. También existe `PUT /crm/agents/sedes`
(`{ agents: [{ email, sedes }] }`).

Operación manual (apikey global, contra `127.0.0.1:8091` en el VPS):

```bash
# evaluar un día sin enviar (piloto / reproceso)
curl -s -X POST -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-22"}' http://127.0.0.1:8091/crm/commercial-audit/runs
# estado y vista previa
curl -s -H "apikey: $KEY" http://127.0.0.1:8091/crm/commercial-audit/runs/2026-10-22
curl -s -H "apikey: $KEY" http://127.0.0.1:8091/crm/commercial-audit/runs/2026-10-22/html > reporte.html
# enviar (con "to" solo a esas direcciones, sin marcarlo como enviado)
curl -s -X POST -H "apikey: $KEY" -H 'Content-Type: application/json' \
  -d '{"to":["desarrollo@brittanygroup.edu.pe"]}' \
  http://127.0.0.1:8091/crm/commercial-audit/runs/2026-10-22/send
```

## Desplegar

Camino normal: GitHub Actions de cada repo → _Despliegue a Producción (VPS
Brittany — Lydia)_ → _Run workflow_ (solo desde `main`). rsync sube el
código fuente a `/lydia_prod/back/` o `/lydia_prod/front/`, y el wrapper de
sudo correspondiente hace `docker compose build` + `up -d` del servicio
afectado — el build corre en el propio VPS, no hay registry.

## Provisioning inicial (una sola vez)

1. Instalar Docker Engine + plugin compose en el VPS.
2. Crear `deploy_lydia` (sin pertenecer al grupo `docker`: todo lo que
   toca Docker pasa por los wrappers de sudo, igual que el resto de
   proyectos nunca corre `systemctl` con argumentos libres).
3. Copiar esta carpeta (`docker-compose.yml`, `init-databases.sh`,
   `.env.example`, `generate_secrets.sh`) a `/lydia_prod/`, correr
   `./generate_secrets.sh` ahí para generar el `.env` real (600, root).
4. `docker compose up -d db redis`, esperar healthy, después
   `docker compose up -d --build audio-converter frontend evolution-api`.
5. Nginx + certbot para `crm.brittanygroup.edu.pe` y
   `api-crm.brittanygroup.edu.pe` (DNS de ambos ya apunta a la IP del VPS).

## Todavía no configurado

- **CRM-12**: endpoints reales de conversaciones/asignación/notas en
  `lydia_bg_back`, y apuntar `frontend` ahí en vez de a datos de ejemplo.
- **Notificación de licencia de Evolution API** (obligatoria por su licencia
  Apache 2.0 + condición adicional, ver `lydia_bg_back/CLAUDE.md`): falta
  agregarla en algún panel de administración visible de Lydia.
- **Backups** de `lydia_pg_data` / `lydia_evolution_instances`: todavía no
  hay cron ni copia off-site para estos volúmenes, a diferencia del MySQL
  del host (ver `docs_brittanygroup` para el mecanismo existente).
- **`lydia_chatwoot_data`** (volumen del Chatwoot ya retirado) y la base
  `chatwoot_production` (si llegó a crearse) quedaron huérfanos en el VPS —
  limpiarlos a mano una vez confirmado que nada los usa.
