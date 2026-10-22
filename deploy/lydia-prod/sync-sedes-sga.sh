#!/usr/bin/env bash
# LYD-104: copia a Lydia las sedes de cada agente segun el SGA (fuente de
# verdad: users -> user_sedes -> sedes), cruzando por email y sin filtrar por
# rol (hay agentes de Lydia que en el SGA son admin, no asesora). Solo lee el
# SGA; en Lydia solo toca Agent.sedes de los agentes que existen en el SGA.
#
# Uso en el VPS:  sudo /lydia_prod/back/deploy/lydia-prod/sync-sedes-sga.sh
set -euo pipefail

SGA_DB="${SGA_DB:-payxiohs_sga_prod}"

# Cada fila sale ya como tupla SQL: ('email', ARRAY['Sede A','Sede B']::text[])
values="$(mysql -N -B "$SGA_DB" -e "
  SELECT CONCAT('(', QUOTE(LOWER(u.email)), ', ARRAY[',
                GROUP_CONCAT(DISTINCT QUOTE(s.name) ORDER BY s.name SEPARATOR ','), ']::text[])')
  FROM users u
  JOIN user_sedes us ON us.user_id = u.id
  JOIN sedes s ON s.id = us.sede_id AND s.active = 1
  WHERE u.active = 1 AND u.email IS NOT NULL AND u.email <> ''
  GROUP BY u.id, u.email" | paste -sd, -)"

if [ -z "$values" ]; then
  echo "El SGA no devolvio usuarios con sede; no se cambia nada." >&2
  exit 1
fi

docker exec -i lydia_postgres sh -c 'psql -U "$POSTGRES_USER" -d evolution -v ON_ERROR_STOP=1 -q' <<SQL
BEGIN;
UPDATE "Agent" a SET sedes = v.sedes, "updatedAt" = now()
FROM (VALUES $values) AS v(email, sedes)
WHERE lower(a.email) = v.email AND a.sedes IS DISTINCT FROM v.sedes;
COMMIT;
SELECT name AS agente, COALESCE(NULLIF(array_to_string(sedes, ', '), ''), '(sin sede)') AS sedes
FROM "Agent" WHERE active ORDER BY name;
SQL
