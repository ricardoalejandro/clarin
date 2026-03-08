#!/bin/bash
echo "[*] Waiting for Mistral 7B model to be ready..."
for i in {1..600}; do
  if docker exec clarin-ollama ollama list 2>/dev/null | grep -q "mistral"; then
    echo "[+] Mistral model loaded!"
    break
  fi
  echo -n "."
  sleep 1
done
echo ""
echo "[*] Starting backend..."
docker compose up -d backend
docker logs clarin-backend --tail=20
