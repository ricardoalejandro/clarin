.PHONY: build build-backend build-frontend build-codex-bridge up down logs logs-backend logs-frontend logs-codex-bridge restart restart-backend migrate seed test clean install deploy offline-installer offline-artifact-check

# V3 is an explicit rollout, never an implicit consequence of rebuilding Clarin.
OFFLINE_V3_ENABLED ?= false
export OFFLINE_V3_ENABLED
# No new enrollments through the retired Electron flow during v3 rollout.
OFFLINE_ENROLLMENT_ENABLED ?= false
export OFFLINE_ENROLLMENT_ENABLED
# Browser-only rollout is independent of the retired native installer. Compose
# reads its flags from the environment/.env and defaults to false; do not export
# empty Make variables that would silently mask a persisted rollout decision.

# ===================
# Docker Compose (single file: docker-compose.yml)
# ===================
build:
	docker compose build

build-backend:
	docker compose build backend

build-frontend:
	docker compose build frontend

build-codex-bridge:
	docker compose build codex-bridge

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

logs-codex-bridge:
	docker compose logs -f codex-bridge

restart:
	docker compose restart

restart-backend:
	docker compose restart backend

offline-installer:
	bash ./infra/offline/build-v3-candidate.sh

offline-artifact-check:
	node scripts/offline/release-artifact.mjs verify

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

# Deploy with version injection
deploy:
	@cp CHANGELOG.md backend/CHANGELOG.md
	@if [ "$$OFFLINE_V3_ENABLED" = "true" ]; then \
	OFFLINE_ARTIFACTS_DIR=$$(node scripts/offline/release-artifact.mjs freeze) && \
	OFFLINE_INSTALLER_SHA256=$$(node scripts/offline/release-artifact.mjs verify "$$OFFLINE_ARTIFACTS_DIR") && \
	export OFFLINE_ARTIFACTS_DIR OFFLINE_INSTALLER_SHA256 || exit 1; \
	fi && \
	BUILD_VERSION=$$(./version.sh) && \
	echo "🚀 Deploying Clarin CRM v$$BUILD_VERSION" && \
	docker compose build offline-signer codex-bridge && \
	docker compose build --build-arg BUILD_VERSION=$$BUILD_VERSION backend task-preview-worker && \
	docker compose build --build-arg BUILD_VERSION=$$BUILD_VERSION frontend && \
	node scripts/offline/install-browser-proxy.mjs && \
	docker compose up -d offline-signer codex-bridge backend task-preview-worker frontend && \
	echo "✅ Deployed v$$BUILD_VERSION"

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
