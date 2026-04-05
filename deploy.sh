#!/bin/bash
set -e

DEPLOY_DIR="/var/www/quant-hunter-proxy"
ENV_FILE="$DEPLOY_DIR/.env"

echo "🚀 Deploy QUANT HUNTER Twitter Proxy"

# Verifica .env
if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Arquivo .env não encontrado em $ENV_FILE"
  echo "   Crie com: echo 'TWITTER_BEARER_TOKEN=seu_token' > $ENV_FILE"
  exit 1
fi

cd "$DEPLOY_DIR"

# Para container anterior se existir
docker compose down --remove-orphans 2>/dev/null || true

# Build e sobe
docker compose --env-file "$ENV_FILE" up -d --build

echo "✅ Proxy rodando na porta 3001"
echo "📋 Logs: docker compose logs -f"
