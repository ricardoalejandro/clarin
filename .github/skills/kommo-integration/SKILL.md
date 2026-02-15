---
name: kommo-integration
description: Work with Kommo CRM integration in Clarin. Use when modifying the sync worker, API client, lead/contact/tag synchronization, or phone normalization. Covers the one-way Kommo to Clarin sync flow.
---

# Kommo CRM Integration — Clarin CRM

## Architecture

Kommo integration is a **one-way sync** (Kommo → Clarin) using the Kommo REST API v4.

```
backend/internal/kommo/
  client.go     → Rate-limited HTTP client for Kommo API
  sync.go       → SyncService: background worker (5s polling)
```

## Sync Flow

1. `SyncService.Start()` launches a goroutine that polls every 5 seconds
2. Fetches leads, contacts, tags from Kommo API
3. Upserts into PostgreSQL via `repository.go`
4. Broadcasts `lead_update` via WebSocket after sync

## Key Components

### client.go — Kommo API Client
- Rate-limited (respects Kommo's API limits)
- `GetLeads()` — Fetches leads with pagination
- `GetContacts()` — Fetches contacts with pagination
- `GetTags()` — Fetches ALL tags with full pagination (fixed: was only page 1)
- Auth via Bearer token from environment variable

### sync.go — Sync Service
- `SyncService` struct with `client`, `repo`, `db`, `hub`
- `upsertLead()` → creates/updates lead, calls `syncLeadTags()`
- `upsertContact()` → creates/updates contact, calls `syncContactTags()`
- `syncLeadTags()` → populates `lead_tags` junction table
- `syncContactTags()` → populates `contact_tags` junction table
- `NormalizePhone()` → Exported function for phone normalization

## Phone Normalization

```go
// Peru (51) is the only country supported
// 9-digit numbers starting with 9 get "51" prefix automatically
normalized := kommo.NormalizePhone("987654321")  // → "51987654321"
normalized := kommo.NormalizePhone("51987654321") // → "51987654321" (unchanged)
```

**ALWAYS use `kommo.NormalizePhone()` when handling phone numbers** in:
- `api/server.go` → `handleCreateLead()`
- `service/service.go` → `CreateNewChat()`
- `kommo/sync.go` → all sync operations

## Adding New Synced Fields

1. Add field to Kommo API response struct
2. Add field to domain entity in `domain/entities.go`
3. Add migration in `database.go`
4. Update `upsertLead()` or `upsertContact()` in `sync.go`
5. Update repository queries
6. Build, deploy, verify sync in logs
