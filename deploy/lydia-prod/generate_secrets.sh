#!/bin/bash
set -euo pipefail

# ==============================================================================
# Script: generate_secrets.sh
# Proposito: generar automaticamente las claves criptograficas de .env para
# la instancia de PRODUCCION de Lydia en el VPS de Brittany (CRM-10).
# ==============================================================================

ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

echo ">>> [DevOps] Generando credenciales criptograficas para Lydia (prod)..."

if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: 'openssl' no esta instalado en este sistema. Instalalo con 'sudo apt-get install -y openssl'."
    exit 1
fi

if [ -f "$ENV_FILE" ]; then
    echo "AVISO: El archivo '$ENV_FILE' ya existe."
    read -p "Deseas sobrescribirlo con nuevos secretos? (s/N): " RESP
    if [[ ! "$RESP" =~ ^[sS]$ ]]; then
        echo "Operacion cancelada. El archivo .env no fue modificado."
        exit 0
    fi
fi

if [ ! -f "$ENV_EXAMPLE" ]; then
    echo "ERROR: No se encontro el archivo '$ENV_EXAMPLE'."
    exit 1
fi

cp "$ENV_EXAMPLE" "$ENV_FILE"

SEC_PG_PASS=$(openssl rand -hex 18)
SEC_REDIS_PASS=$(openssl rand -hex 18)
SEC_EVO_KEY=$(openssl rand -hex 24)
SEC_AUDIO_CONVERTER_KEY=$(openssl rand -hex 24)
SEC_LANDING_TOKEN=$(openssl rand -hex 24)

sed -i "s|reemplazar_por_password_seguro_sin_caracteres_conflictivos|${SEC_PG_PASS}|g" "$ENV_FILE"
sed -i "s|reemplazar_por_password_seguro_redis|${SEC_REDIS_PASS}|g" "$ENV_FILE"
sed -i "s|reemplazar_por_token_secreto_evolution|${SEC_EVO_KEY}|g" "$ENV_FILE"
sed -i "s|reemplazar_por_token_secreto_audio_converter|${SEC_AUDIO_CONVERTER_KEY}|g" "$ENV_FILE"
sed -i "s|reemplazar_por_token_secreto_landing|${SEC_LANDING_TOKEN}|g" "$ENV_FILE"

chmod 600 "$ENV_FILE"

echo ""
echo "Archivo .env generado con secretos criptograficos de alta entropia."
echo "Permisos de .env restringidos a 600 (solo lectura para el dueno, root)."
echo ""
echo "FRONTEND_DOMAIN y EVO_DOMAIN ya vienen fijados a crm.brittanygroup.edu.pe"
echo "y api-crm.brittanygroup.edu.pe -- no deberian necesitar edicion."
