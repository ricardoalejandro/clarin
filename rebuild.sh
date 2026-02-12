#!/bin/bash
cd /root/proyect/clarin
docker compose -f docker-compose.prod.yml up -d --build backend
echo "Backend rebuild completed at $(date)" >> /tmp/rebuild.log
docker ps --format "table {{.Names}}\t{{.Status}}" | grep clarin >> /tmp/rebuild.log
