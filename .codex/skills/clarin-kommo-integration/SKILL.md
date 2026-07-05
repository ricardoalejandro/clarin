---
name: clarin-kommo-integration
description: Use when modifying Clarin Kommo compatibility data, local Excel imports, phone normalization, Kommo status/date tags, observations, or dormant Kommo API code.
---

# Clarin Kommo Integration

## Current Rule

- Kommo API communication is intentionally dormant.
- Do not start `kommo.Manager`, pollers, outbox jobs, reconciliation workers, auto-webhook registration, frontend sync actions, or direct Kommo API mutations unless the user explicitly requests reactivation.
- Keep client structs, `kommo_id` metadata, helpers, and dormant code only for compatibility.
- The active supported flow is local Excel import.

## Excel Import Behavior

- UI accepts `.xlsx/.xls`; internal conversion to CSV is acceptable when reusing existing endpoints.
- Use `kommo.NormalizePhone()` for matching and creation.
- New leads can be created when validation passes, even if Kommo creation date is older than 24 hours.
- The 24-hour rule only controls updates to existing Clarin leads/contacts.
- Existing leads outside the 24-hour window must not be modified.
- Existing leads inside the window may sync only Kommo status/date tags unless the user requests more.

## Tags And Observations

- Closed Kommo status tag set: `CONFIRMADO`, `FLUJO INCOMPLETO`, `OTRAS CONSULTAS`, `REVIVIO`, `NO RESPONDE`.
- Keep only one status tag from that set per contact, case-insensitively and tolerating extra spaces.
- Do not remove unrelated tags.
- For new leads only, create an observation when values exist: `Komo: Status: <status>; Campana: <campana>`.

## Safety

- Reimports must be idempotent.
- Do not log raw workbook rows, personal data beyond necessary counts, tokens, or secrets.
- Preserve account isolation during matching, creation, tag updates, and notes.
