.PHONY: dev dev-backend dev-frontend build up down logs migrate seed test clean

# Development
dev:
	docker-compose up -d postgres redis
	@echo "Waiting for services..."
	@sleep 3
	@make -j2 dev-backend dev-frontend

dev-backend:
	cd backend && go run ./cmd/server

dev-frontend:
	cd frontend && npm run dev

# Docker Development
build:
	docker-compose build

up:
	docker-compose up -d

down:
	docker-compose down

logs:
	docker-compose logs -f

logs-backend:
	docker-compose logs -f backend

logs-frontend:
	docker-compose logs -f frontend

# ===================
# Production (Dokploy)
# ===================
prod-build:
	docker-compose -f docker-compose.prod.yml build

prod-up:
	docker-compose -f docker-compose.prod.yml up -d

prod-down:
	docker-compose -f docker-compose.prod.yml down

prod-logs:
	docker-compose -f docker-compose.prod.yml logs -f

prod-restart:
	docker-compose -f docker-compose.prod.yml restart

# Database
db:
	docker-compose up -d postgres redis

migrate:
	cd backend && go run ./cmd/server migrate

migrate-down:
	cd backend && go run ./cmd/server migrate down

seed:
	cd backend && go run ./cmd/server seed

# Testing
test:
	cd backend && go test ./...

test-coverage:
	cd backend && go test -coverprofile=coverage.out ./...
	cd backend && go tool cover -html=coverage.out

# Cleanup
clean:
	docker-compose down -v
	rm -rf backend/sessions/*
	rm -rf frontend/.next frontend/node_modules

clean-prod:
	docker-compose -f docker-compose.prod.yml down -v

# Install dependencies
install:
	cd backend && go mod download
	cd frontend && npm install

# Quick restart backend
restart-backend:
	docker-compose restart backend

# Enter containers
shell-backend:
	docker-compose exec backend sh

shell-postgres:
	docker-compose exec postgres psql -U clarin -d clarin

shell-redis:
	docker-compose exec redis redis-cli

# Production shell access
prod-shell-backend:
	docker-compose -f docker-compose.prod.yml exec backend sh

prod-shell-postgres:
	docker-compose -f docker-compose.prod.yml exec postgres psql -U $${POSTGRES_USER:-clarin} -d $${POSTGRES_DB:-clarin}
