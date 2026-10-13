# codex-bridge

Puente HTTP entre Lydia (contenedores Docker) y el `codex` headless del host del VPS. Lo usa la sugerencia de respuesta con IA (`POST /crm/conversations/:chatId/suggest-reply`).

- Servicio de systemd `lydia-codex-bridge` (unit en este directorio), escucha solo en `172.18.0.1:3920` (gateway de la red Docker de Lydia). Código en `/opt/lydia-codex-bridge/server.mjs`.
- Configuración en `/etc/lydia-codex-bridge.env` (`CODEX_BRIDGE_TOKEN`, `BRIDGE_HOST`, `BRIDGE_PORT`, `CODEX_MODEL`). El token también está en el vault de Ragnar (empresa Brittany Group, entidad "Lydia - codex bridge").
- El contenedor `evolution-api` recibe `CODEX_BRIDGE_URL` y `CODEX_BRIDGE_TOKEN` (ver `docker-compose.yml`; el token sale de `/lydia_prod/.env`).
- Regla de ufw: `ufw allow from 172.18.0.0/16 to 172.18.0.1 port 3920 proto tcp`.
- Login de codex: `codex login` por navegador como root en el VPS (sesión propia, no se copia el `auth.json` de otro servidor). Estado: `codex login status`.

Actualizar el servicio tras un cambio en `server.mjs`: copiarlo a `/opt/lydia-codex-bridge/` y `systemctl restart lydia-codex-bridge`.

## Modelo

`CODEX_MODEL=gpt-6-luna`, con el razonamiento por defecto del modelo (`medium`). Sin esa variable, codex usa su modelo por defecto (`gpt-6.1-sol`), que con el prompt del chat del agente (instrucciones, conocimiento, plantillas y conversación, unos 16 mil caracteres) tarda entre 12 y 23 s por respuesta. `gpt-6-luna` responde en 3 a 6 s con los mismos datos correctos y JSON válido. Bajar el razonamiento a `low` no lo acelera más, y codex no ofrece un nivel sin razonamiento.

Los modelos disponibles para la cuenta están en `/root/.codex/models_cache.json`. Para cambiar el modelo, editar la variable en el `.env` y correr `systemctl restart lydia-codex-bridge`.
