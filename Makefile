.PHONY: build up down logs restart migrate seed test clean install

# ===================
# Docker Compose (single file: docker-compose.yml)
# ===================
build:
	docker compose build

build-backend:
	docker compose build backend

build-frontend:
	docker compose build frontend

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

logs-backend:
	docker compose logs -f backend

logs-frontend:
	docker compose logs -f frontend

restart:
	docker compose restart

restart-backend:
	docker compose restart backend

# Database
db:
	docker compose up -d postgres redis

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
	docker compose down -v
	rm -rf backend/sessions/*
	rm -rf frontend/.next frontend/node_modules

# Install dependencies
install:
	cd backend && go mod download
	cd frontend && npm install

# Enter containers
shell-backend:
	docker compose exec backend sh

shell-postgres:
	docker compose exec postgres psql -U $${POSTGRES_USER:-clarin} -d $${POSTGRES_DB:-clarin}

shell-redis:
	docker compose exec redis redis-cli
